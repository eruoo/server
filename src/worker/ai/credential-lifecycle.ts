import type { OwnerSession } from "../http/types"
import { getAiConnection, type AiConnectionRecord } from "./connections"
import {
  AiCredentialCipherError,
  decryptAiSecret,
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "./credential-cipher"

export interface AiCredentialServiceContext {
  credentialKeys: string
  database: D1Database
  environment: string
}

export function isDeepSeekApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value)
}

/** Fixed identity and expiry checks are repeated in the credential write itself. */
const ownerSessionGuard = `EXISTS (SELECT 1 FROM session AS s
  JOIN account AS a ON a.userId=s.userId AND a.providerId='github'
  WHERE s.id=? AND s.userId=? AND a.accountId=?
    AND julianday(s.expiresAt)>julianday('now'))`

export async function saveDeepSeekCredential(
  context: AiCredentialServiceContext,
  input: {
    connectionId: string
    apiKey: string
    expectedVersion: number
    owner: OwnerSession
    ownerGitHubId: string
  },
): Promise<"saved" | "invalid-session" | "conflict" | "not-found"> {
  if (
    !isDeepSeekApiKey(input.apiKey) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  )
    throw new RangeError("Invalid credential input")
  const keyring = await parseAiCredentialKeyring(context.credentialKeys)
  const ciphertext = await encryptAiSecret(
    keyring,
    JSON.stringify({ kind: "api-key", apiKey: input.apiKey }),
    {
      connectionId: input.connectionId,
      environment: context.environment,
      providerType: "deepseek",
      purpose: "credential-package",
    },
  )
  const now = Date.now()
  const sessionValues = [
    input.owner.sessionId,
    input.owner.subject,
    input.ownerGitHubId,
  ]
  // The write checks the persistent session at commit time. Snapshot deletion
  // follows only the exact winning ciphertext, in the same transaction.
  const guard = `id=? AND credentialVersion=? AND providerType='deepseek' AND ${ownerSessionGuard}`
  const results = await context.database.batch([
    context.database
      .prepare(`UPDATE ai_connections SET credentialCiphertext=?,
      authorizationStatus='connected', credentialVersion=credentialVersion+1, updatedAt=?
      WHERE ${guard}`)
      .bind(
        ciphertext,
        now,
        input.connectionId,
        input.expectedVersion,
        ...sessionValues,
      ),
    context.database
      .prepare(`DELETE FROM ai_models WHERE connectionId IN (
        SELECT id FROM ai_connections WHERE id=? AND credentialVersion=? AND credentialCiphertext=?)`)
      .bind(input.connectionId, input.expectedVersion + 1, ciphertext),
  ])
  if (results[0].meta.changes === 1) return "saved"
  const session = await context.database
    .prepare(`SELECT 1 WHERE ${ownerSessionGuard}`)
    .bind(...sessionValues)
    .first()
  if (!session) return "invalid-session"
  return (await getAiConnection(context.database, input.connectionId)) === null
    ? "not-found"
    : "conflict"
}

/** A late rejection can invalidate only the credential that actually failed. */
export async function markAiCredentialInvalid(
  database: D1Database,
  connectionId: string,
  version: number,
): Promise<void> {
  await database
    .prepare(`UPDATE ai_connections SET authorizationStatus='reauthentication_required',
    credentialCiphertext=NULL, credentialVersion=credentialVersion+1, updatedAt=?3
    WHERE id=?1 AND credentialVersion=?2 AND authorizationStatus='connected'`)
    .bind(connectionId, version, Date.now())
    .run()
}

export type AiCredentialAccessResult =
  | { status: "usable"; apiKey: string; connection: AiConnectionRecord }
  | {
      status:
        | "connection-not-found"
        | "disabled"
        | "reauthentication-required"
        | "upstream-unavailable"
        | "timed-out"
    }

async function readDeepSeekCredentials(
  context: AiCredentialServiceContext,
  input: { connectionId: string; deadlineAt: number; signal?: AbortSignal },
): Promise<AiCredentialAccessResult> {
  if (input.signal?.aborted || Date.now() >= input.deadlineAt)
    return { status: "timed-out" }
  const connection = await getAiConnection(context.database, input.connectionId)
  if (connection === null) return { status: "connection-not-found" }
  if (!connection.enabled) return { status: "disabled" }
  if (
    connection.providerType !== "deepseek" ||
    connection.authorizationStatus !== "connected" ||
    connection.credentialCiphertext === null
  )
    return { status: "reauthentication-required" }
  // A missing encryption secret is an operational failure, not evidence that the upstream key is invalid.
  let keyring
  try {
    keyring = await parseAiCredentialKeyring(context.credentialKeys)
  } catch {
    return { status: "upstream-unavailable" }
  }
  try {
    const raw = await decryptAiSecret(
      keyring,
      connection.credentialCiphertext,
      {
        connectionId: connection.id,
        environment: context.environment,
        providerType: connection.providerType,
        purpose: "credential-package",
      },
    )
    const stored = JSON.parse(raw) as { kind?: unknown; apiKey?: unknown }
    if (stored.kind !== "api-key" || !isDeepSeekApiKey(stored.apiKey))
      return { status: "reauthentication-required" }
    if (input.signal?.aborted || Date.now() >= input.deadlineAt)
      return { status: "timed-out" }
    return { status: "usable", apiKey: stored.apiKey, connection }
  } catch (error) {
    return {
      status:
        error instanceof AiCredentialCipherError &&
        error.kind === "key-not-found"
          ? "upstream-unavailable"
          : "reauthentication-required",
    }
  }
}

/** Reading can finish late, but it has no side effects and can never start an upstream call. */
export async function accessDeepSeekCredentials(
  context: AiCredentialServiceContext,
  input: { connectionId: string; deadlineAt: number; signal?: AbortSignal },
): Promise<AiCredentialAccessResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const expired = new Promise<AiCredentialAccessResult>((resolve) => {
    onAbort = () => resolve({ status: "timed-out" })
    timer = setTimeout(onAbort, Math.max(0, input.deadlineAt - Date.now()))
    input.signal?.addEventListener("abort", onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
  })
  try {
    return await Promise.race([
      readDeepSeekCredentials(context, input),
      expired,
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) input.signal?.removeEventListener("abort", onAbort)
  }
}

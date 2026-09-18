import {
  AI_CREDENTIAL_REFRESH_LEAD_MS,
  AI_CREDENTIAL_REFRESH_NETWORK_BUDGET_MS,
} from "../../shared/ai"
import {
  isDefinitiveCodexRefreshRejection,
  readCodexAccessTokenExpiryMs,
  refreshCodexAccessToken,
} from "./codex-connector"
import type { AiConnectionRecord } from "./connections"
import { getAiConnection } from "./connections"
import {
  AiCredentialCipherError,
  decryptAiSecret,
  encryptAiSecret,
  parseAiCredentialKeyring,
  type AiCredentialKeyring,
} from "./credential-cipher"
import {
  acquireAiCredentialRefreshClaim,
  commitAiCredentialRefresh,
  markAiConnectionReauthenticationRequired,
  releaseAiCredentialRefreshClaim,
} from "./credentials"
import type { AiStageUpstreamBudget } from "./stage-budget"

/**
 * Upstream credential access and refresh orchestration.
 *
 * This is the single place that decides when a stored Codex credential
 * package may be used, when it must be refreshed, and how every refresh
 * failure window resolves. The rules come from docs/specs/ai-service.md
 * §5.3:
 *
 * - Refresh starts 60 seconds before the recorded expiry.
 * - One refresher per credential version through the D1 claim; other callers
 *   with an insufficient token see the busy result with the claim's remaining
 *   time, and callers with a still-sufficient token keep using it.
 * - The refresh network budget is 10 seconds including the response body,
 *   always truncated by the invoking stage's remaining budget. A refresh
 *   that provably never reached the upstream (budget exhausted before the
 *   fetch) releases the claim, keeps the credential, and reports the
 *   retryable upstream-unavailable result.
 * - Definitive upstream rejections (400 invalid_grant per the reference
 *   classifier, or 401) and every sent-but-unprovable outcome (5xx, 429,
 *   timeout, transport error, unparseable 200) move the connection into
 *   reauthentication required — this service never replays a refresh token
 *   whose consumption state is unknown.
 * - A refreshed token is usable only after its D1 commit succeeded. A commit
 *   that lost to a concurrent writer re-reads the row: another refresher's
 *   result makes the call usable, a disconnect/reauthorization keeps the
 *   reauthentication result.
 */

export interface AiCredentialServiceContext {
  /** Raw AI_CREDENTIAL_KEYS value; parsed on demand, never cached. */
  credentialKeys: string
  database: D1Database
  /** Deployment identity bound into every ciphertext's AAD. */
  environment: string
}

export interface AiCredentialAccessRequest {
  connectionId: string
  deadlineAt: number
  now: number
  signal?: AbortSignal
  /** Shared stage budget; when absent the refresh uses its own 10-second cap. */
  upstream?: AiStageUpstreamBudget
}

export type AiReauthenticationReason =
  | "not-connected"
  | "invalid-grant"
  | "refresh-outcome-unknown"
  | "refresh-claim-expired"
  | "ciphertext-unreadable"
  | "token-response-invalid"

export type AiCredentialAccessResult =
  | {
      status: "usable"
      connection: AiConnectionRecord
      accessToken: string
      /** ChatGPT workspace identifier used in upstream account headers. */
      accountId: string | null
    }
  | { status: "connection-not-found" }
  | { status: "disabled" }
  | { status: "reauthentication-required"; reason: AiReauthenticationReason }
  | { status: "credential-busy"; retryAfterMs: number }
  /** The refresh provably never reached the upstream; retry later. */
  | { status: "upstream-unavailable" }

export interface AiStoredCredentialPackage {
  accessToken: string
  chatgptUserId: string | null
  refreshToken: string
}

const AI_CREDENTIAL_PACKAGE_ACCESS_TOKEN_MAX_LENGTH = 2_048
const AI_CREDENTIAL_PACKAGE_REFRESH_TOKEN_MAX_LENGTH = 512

function parseStoredPackage(raw: string): AiStoredCredentialPackage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (
    typeof record.accessToken !== "string" ||
    record.accessToken.length === 0 ||
    record.accessToken.length > AI_CREDENTIAL_PACKAGE_ACCESS_TOKEN_MAX_LENGTH
  ) {
    return null
  }
  if (
    typeof record.refreshToken !== "string" ||
    record.refreshToken.length === 0 ||
    record.refreshToken.length > AI_CREDENTIAL_PACKAGE_REFRESH_TOKEN_MAX_LENGTH
  ) {
    return null
  }
  if (
    record.chatgptUserId !== null &&
    record.chatgptUserId !== undefined &&
    (typeof record.chatgptUserId !== "string" ||
      record.chatgptUserId.length === 0)
  ) {
    return null
  }
  return {
    accessToken: record.accessToken,
    chatgptUserId:
      typeof record.chatgptUserId === "string" ? record.chatgptUserId : null,
    refreshToken: record.refreshToken,
  }
}

async function readStoredPackage(
  context: AiCredentialServiceContext,
  connection: AiConnectionRecord,
): Promise<
  | {
      ok: true
      keyring: AiCredentialKeyring
      package: AiStoredCredentialPackage
    }
  | { ok: false }
> {
  if (connection.credentialCiphertext === null) return { ok: false }
  let keyring: AiCredentialKeyring
  try {
    keyring = await parseAiCredentialKeyring(context.credentialKeys)
  } catch {
    return { ok: false }
  }
  try {
    const plaintext = await decryptAiSecret(
      keyring,
      connection.credentialCiphertext,
      {
        connectionId: connection.id,
        environment: context.environment,
        providerType: connection.providerType,
        purpose: "credential-package",
      },
    )
    const stored = parseStoredPackage(plaintext)
    return stored === null
      ? { ok: false }
      : { ok: true, keyring, package: stored }
  } catch {
    return { ok: false }
  }
}

/**
 * Fallback lifetime for access tokens whose response carries neither an
 * `expires_in` nor a parseable `exp` claim. It mirrors the reference
 * connector's 3600-second default and is recorded as an assumption to verify
 * during real staging authorization.
 */
export const AI_CREDENTIAL_DEFAULT_LIFETIME_MS = 3_600_000

function deriveCredentialExpiry(input: {
  expiresIn?: number
  mergedAccessToken: string
  now: number
  previousAccessToken: string
  previousExpiresAt: number
}): number | null {
  if (input.mergedAccessToken !== input.previousAccessToken) {
    if (input.expiresIn !== undefined) {
      const expiry = input.now + input.expiresIn * 1_000
      return Number.isSafeInteger(expiry) ? expiry : null
    }
    const tokenExpiry = readCodexAccessTokenExpiryMs(input.mergedAccessToken)
    if (tokenExpiry !== null) return tokenExpiry
    return input.now + AI_CREDENTIAL_DEFAULT_LIFETIME_MS
  }
  // The access token is unchanged; the previous expiry still governs it.
  return input.previousExpiresAt
}

async function transitionToReauthentication(
  context: AiCredentialServiceContext,
  input: { connectionId: string; claimId?: string; now: number },
): Promise<void> {
  await markAiConnectionReauthenticationRequired(context.database, {
    claimId: input.claimId,
    connectionId: input.connectionId,
    now: input.now,
  })
}

async function classifyAfterCommitLoss(
  context: AiCredentialServiceContext,
  input: { connectionId: string; now: number },
): Promise<AiCredentialAccessResult> {
  // The commit lost to a concurrent writer or a state transition. Re-read
  // the row and classify what actually happened; never retry the network
  // call with the same possibly-consumed refresh token.
  const connection = await getAiConnection(context.database, input.connectionId)
  if (connection === null) return { status: "connection-not-found" }
  if (
    connection.authorizationStatus !== "connected" ||
    connection.credentialCiphertext === null
  ) {
    return { status: "reauthentication-required", reason: "not-connected" }
  }
  const stored = await readStoredPackage(context, connection)
  if (!stored.ok) {
    return {
      status: "reauthentication-required",
      reason: "ciphertext-unreadable",
    }
  }
  if (connection.enabled === false) return { status: "disabled" }
  if (
    connection.credentialExpiresAt !== null &&
    connection.credentialExpiresAt > input.now + AI_CREDENTIAL_REFRESH_LEAD_MS
  ) {
    return {
      status: "usable",
      accountId: connection.upstreamAccountId,
      accessToken: stored.package.accessToken,
      connection,
    }
  }
  // Another writer committed but the result still needs another refresh;
  // the caller reports busy-style unavailability rather than recursing.
  return { status: "credential-busy", retryAfterMs: 1_000 }
}

export async function accessCodexCredentials(
  context: AiCredentialServiceContext,
  request: AiCredentialAccessRequest,
): Promise<AiCredentialAccessResult> {
  const connection = await getAiConnection(
    context.database,
    request.connectionId,
  )
  if (connection === null) return { status: "connection-not-found" }
  if (!connection.enabled) return { status: "disabled" }
  if (
    connection.authorizationStatus !== "connected" ||
    connection.credentialCiphertext === null ||
    connection.credentialExpiresAt === null
  ) {
    return { status: "reauthentication-required", reason: "not-connected" }
  }

  const stored = await readStoredPackage(context, connection)
  if (!stored.ok) {
    // The stored package cannot be decrypted or parsed: the credential is
    // unusable and no refresh can recover it. Transition terminally.
    await transitionToReauthentication(context, {
      connectionId: connection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "ciphertext-unreadable",
    }
  }

  if (
    connection.credentialExpiresAt >
    request.now + AI_CREDENTIAL_REFRESH_LEAD_MS
  ) {
    return {
      status: "usable",
      accountId: connection.upstreamAccountId,
      accessToken: stored.package.accessToken,
      connection,
    }
  }

  // Refresh is required. Acquire the single-writer claim for this version.
  const claimId = crypto.randomUUID()
  const claimed = await acquireAiCredentialRefreshClaim(context.database, {
    claimId,
    connectionId: connection.id,
    now: request.now,
  })
  if (!claimed.claimed) {
    if (claimed.reason === "connection-not-found") {
      return { status: "connection-not-found" }
    }
    if (claimed.reason === "reauthentication-required") {
      // The acquire itself cleared an expired claim into the uncertain
      // state, or the connection already left the connected state.
      return {
        status: "reauthentication-required",
        reason: claimed.uncertainClaimCleared
          ? "refresh-claim-expired"
          : "not-connected",
      }
    }
    const remaining =
      claimed.refreshClaimExpiresAt === undefined ||
      claimed.refreshClaimExpiresAt === null
        ? 1_000
        : Math.max(1_000, claimed.refreshClaimExpiresAt - request.now)
    return { status: "credential-busy", retryAfterMs: remaining }
  }

  // The claim's own snapshot is authoritative for this refresh attempt.
  const claimedConnection = claimed.connection
  const claimedStored = await readStoredPackage(context, claimedConnection)
  if (!claimedStored.ok) {
    await transitionToReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "ciphertext-unreadable",
    }
  }

  const remainingBudget = request.deadlineAt - request.now
  if (remainingBudget <= 0) {
    // The refresh provably never reached the upstream: the budget was
    // exhausted before the fetch call. Release the claim and keep the
    // credential for a later retry.
    await releaseAiCredentialRefreshClaim(context.database, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return { status: "upstream-unavailable" }
  }

  let refreshResult: Awaited<ReturnType<typeof refreshCodexAccessToken>>
  if (request.upstream === undefined) {
    const networkBudgetMs = Math.min(
      AI_CREDENTIAL_REFRESH_NETWORK_BUDGET_MS,
      remainingBudget,
    )
    refreshResult = await refreshCodexAccessToken(
      { refreshToken: claimedStored.package.refreshToken },
      { signal: request.signal, timeoutMs: networkBudgetMs },
    )
  } else {
    const attempt = await request.upstream.withinBudget((options) =>
      refreshCodexAccessToken(
        { refreshToken: claimedStored.package.refreshToken },
        { signal: request.signal, timeoutMs: options.timeoutMs },
      ),
    )
    if (!attempt.ok) {
      // The shared upstream budget was exhausted before the fetch call:
      // the refresh provably never reached the upstream.
      await releaseAiCredentialRefreshClaim(context.database, {
        claimId,
        connectionId: claimedConnection.id,
        now: request.now,
      })
      return { status: "upstream-unavailable" }
    }
    refreshResult = attempt.value
  }

  if (!refreshResult.ok) {
    if (isDefinitiveCodexRefreshRejection(refreshResult.failure)) {
      await transitionToReauthentication(context, {
        claimId,
        connectionId: claimedConnection.id,
        now: request.now,
      })
      return { status: "reauthentication-required", reason: "invalid-grant" }
    }
    // The request was sent but its outcome is unprovable: the refresh token
    // may already have been rotated upstream. Never replay it.
    await transitionToReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "refresh-outcome-unknown",
    }
  }

  const merged: AiStoredCredentialPackage = {
    accessToken:
      refreshResult.value.accessToken ?? claimedStored.package.accessToken,
    chatgptUserId: claimedStored.package.chatgptUserId,
    refreshToken:
      refreshResult.value.refreshToken ?? claimedStored.package.refreshToken,
  }
  if (!refreshResult.value.accessToken && !refreshResult.value.refreshToken) {
    // Defensive: the connector already rejects token-less payloads.
    await transitionToReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "token-response-invalid",
    }
  }
  const expiry = deriveCredentialExpiry({
    expiresIn: refreshResult.value.expiresIn,
    mergedAccessToken: merged.accessToken,
    now: request.now,
    previousAccessToken: claimedStored.package.accessToken,
    previousExpiresAt: claimedConnection.credentialExpiresAt ?? request.now,
  })
  if (expiry === null || expiry <= request.now) {
    await transitionToReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "token-response-invalid",
    }
  }

  let mergedCiphertext: string
  try {
    mergedCiphertext = await encryptAiSecret(
      claimedStored.keyring,
      JSON.stringify(merged),
      {
        connectionId: claimedConnection.id,
        environment: context.environment,
        providerType: claimedConnection.providerType,
        purpose: "credential-package",
      },
    )
  } catch (error) {
    if (error instanceof AiCredentialCipherError) {
      await transitionToReauthentication(context, {
        claimId,
        connectionId: claimedConnection.id,
        now: request.now,
      })
      return {
        status: "reauthentication-required",
        reason: "ciphertext-unreadable",
      }
    }
    throw error
  }

  const committed = await commitAiCredentialRefresh(context.database, {
    claimId,
    connectionId: claimedConnection.id,
    credentialCiphertext: mergedCiphertext,
    credentialExpiresAt: expiry,
    now: request.now,
    observedCredentialVersion: claimedConnection.credentialVersion,
  })
  if (committed.committed) {
    const afterCommit = await getAiConnection(
      context.database,
      claimedConnection.id,
    )
    if (afterCommit === null) return { status: "connection-not-found" }
    return {
      status: "usable",
      accountId: afterCommit.upstreamAccountId,
      accessToken: merged.accessToken,
      connection: afterCommit,
    }
  }
  if (committed.reason === "refresh-claim-expired") {
    // The claim reached its expiry during the refresh: the outcome is
    // uncertain and the connection must go through reauthorization.
    await transitionToReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      now: request.now,
    })
    return {
      status: "reauthentication-required",
      reason: "refresh-claim-expired",
    }
  }
  return classifyAfterCommitLoss(context, {
    connectionId: claimedConnection.id,
    now: request.now,
  })
}

/** Exposed for the authorization flow's identity recheck on the stored package. */
export async function readCodexCredentialPackage(
  context: AiCredentialServiceContext,
  connection: AiConnectionRecord,
): Promise<AiStoredCredentialPackage | null> {
  const stored = await readStoredPackage(context, connection)
  return stored.ok ? stored.package : null
}

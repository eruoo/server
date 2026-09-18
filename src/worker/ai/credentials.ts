import {
  AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS,
  isAiServerIdentifier,
} from "../../shared/ai"
import { getAiConnection, type AiConnectionRecord } from "./connections"

/**
 * Durable credential refresh coordination on the connection row.
 *
 * A refresh claim is held through a single conditional write with the claim id
 * and expiry stored on the connection itself; no module-level promise or
 * cross-request lock participates. An expired claim means the previous
 * refresher's outcome is unknown — the refresh token may already have been
 * rotated upstream — so instead of letting a new caller reuse the possibly
 * consumed credential, the connection transitions to reauthentication
 * required. Only a refresh that provably never reached the upstream is
 * released with the credential retained.
 */

export type AiCredentialRefreshClaimResult =
  | { claimed: true; connection: AiConnectionRecord }
  | {
      claimed: false
      reason:
        | "connection-not-found"
        | "reauthentication-required"
        | "refresh-claim-held"
      /** Present when another holder's claim is still active. */
      refreshClaimExpiresAt?: number
      /** True when an expired claim forced the reauthentication transition. */
      uncertainClaimCleared?: boolean
    }

export type AiCredentialRefreshCommitResult =
  | { committed: true }
  | {
      committed: false
      reason:
        | "connection-not-found"
        | "credential-version-changed"
        | "refresh-claim-not-held"
        | "refresh-claim-expired"
        | "credential-state-changed"
    }

function requireEpochMilliseconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be safe epoch milliseconds.`)
  }
}

function readChanges(
  result: D1Result<unknown> | undefined,
  operation: string,
): number {
  const changes = result?.meta.changes
  if (
    typeof changes !== "number" ||
    !Number.isSafeInteger(changes) ||
    changes < 0
  ) {
    throw new TypeError(`The AI credential ${operation} result is invalid.`)
  }
  return changes
}

interface AiCredentialClaimRow {
  id: string
  slug: string
  name: string
  providerType: string
  enabled: number
  authorizationStatus: AiConnectionRecord["authorizationStatus"]
  upstreamAccountId: string | null
  credentialVersion: number
  credentialCiphertext: string | null
  credentialExpiresAt: number | null
  refreshClaimId: string | null
  refreshClaimExpiresAt: number | null
  createdAt: number
  updatedAt: number
}

function toRecord(row: AiCredentialClaimRow): AiConnectionRecord {
  return { ...row, enabled: row.enabled === 1 }
}

export async function acquireAiCredentialRefreshClaim(
  database: D1Database,
  input: { connectionId: string; claimId: string; now: number },
): Promise<AiCredentialRefreshClaimResult> {
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI credential refresh claim id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI credential claim time")

  const claimExpiresAt = input.now + AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS
  if (!Number.isSafeInteger(claimExpiresAt)) {
    throw new RangeError("The AI credential claim expiry is invalid.")
  }

  // Bounded retry: each round either wins the claim, classifies a stable
  // rejection, or resolves a concurrent transition and tries once more.
  for (let attempt = 0; attempt < 3; attempt++) {
    // RETURNING yields the row exactly as this claim wrote it: the returned
    // credential, version, and claim id are one atomic snapshot of this
    // operation's own write. A reauthorization or another holder that lands
    // after the statement cannot substitute its state into the result.
    const claimed = await database
      .prepare(
        `UPDATE "ai_connections"
         SET "refreshClaimId" = ?2, "refreshClaimExpiresAt" = ?3, "updatedAt" = ?1
         WHERE "id" = ?4
           AND "authorizationStatus" = 'connected'
           AND "credentialCiphertext" IS NOT NULL
           AND "refreshClaimId" IS NULL
         RETURNING "id", "slug", "name", "providerType", "enabled",
           "authorizationStatus", "upstreamAccountId", "credentialVersion",
           "credentialCiphertext", "credentialExpiresAt", "refreshClaimId",
           "refreshClaimExpiresAt", "createdAt", "updatedAt"`,
      )
      .bind(input.now, input.claimId, claimExpiresAt, input.connectionId)
      .all<AiCredentialClaimRow>()

    const claimChanges = readChanges(claimed, "refresh claim")
    if (claimChanges === 1 && claimed.results.length === 1) {
      return { claimed: true, connection: toRecord(claimed.results[0]) }
    }
    if (claimChanges !== 0 || claimed.results.length !== 0) {
      throw new TypeError("The AI credential refresh claim result is invalid.")
    }

    const connection = await getAiConnection(database, input.connectionId)
    if (connection === null) {
      return { claimed: false, reason: "connection-not-found" }
    }
    if (
      connection.authorizationStatus !== "connected" ||
      connection.credentialCiphertext === null
    ) {
      return { claimed: false, reason: "reauthentication-required" }
    }
    if (connection.refreshClaimId === null) {
      // The previous holder released or committed between the attempt and
      // this read; the claim is genuinely free again.
      continue
    }
    if (
      connection.refreshClaimExpiresAt !== null &&
      connection.refreshClaimExpiresAt > input.now
    ) {
      return {
        claimed: false,
        reason: "refresh-claim-held",
        refreshClaimExpiresAt: connection.refreshClaimExpiresAt,
      }
    }

    // An expired claim means the earlier refresh outcome is unknown. The
    // possibly rotated credential must not be reused: clear it and require
    // reauthorization, guarded so only one concurrent caller performs the
    // transition.
    const transitioned = await database
      .prepare(
        `UPDATE "ai_connections"
         SET "authorizationStatus" = 'reauthentication_required',
             "credentialCiphertext" = NULL,
             "credentialExpiresAt" = NULL,
             "refreshClaimId" = NULL,
             "refreshClaimExpiresAt" = NULL,
             "credentialVersion" = "credentialVersion" + 1,
             "updatedAt" = ?1
         WHERE "id" = ?2
           AND "authorizationStatus" = 'connected'
           AND "credentialCiphertext" IS NOT NULL
           AND "refreshClaimId" = ?3
           AND "refreshClaimExpiresAt" <= ?1`,
      )
      .bind(input.now, input.connectionId, connection.refreshClaimId)
      .run()

    if (readChanges(transitioned, "uncertain claim clearing") === 1) {
      return {
        claimed: false,
        reason: "reauthentication-required",
        uncertainClaimCleared: true,
      }
    }
    // Another caller resolved the expired claim first; re-read and classify.
  }

  return {
    claimed: false,
    reason: "refresh-claim-held",
    refreshClaimExpiresAt: undefined,
  }
}

/**
 * Releases the claim while keeping the credential. The caller must only use
 * this when it can prove the refresh request was never sent upstream, or the
 * fixed upstream contract guarantees the failure did not consume the refresh
 * token.
 */
export async function releaseAiCredentialRefreshClaim(
  database: D1Database,
  input: { connectionId: string; claimId: string; now: number },
): Promise<{ released: boolean }> {
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI credential refresh claim id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI credential release time")

  const result = await database
    .prepare(
      `UPDATE "ai_connections"
       SET "refreshClaimId" = NULL, "refreshClaimExpiresAt" = NULL, "updatedAt" = ?3
       WHERE "id" = ?1
         AND "authorizationStatus" = 'connected'
         AND "refreshClaimId" = ?2`,
    )
    .bind(input.connectionId, input.claimId, input.now)
    .run()

  return { released: readChanges(result, "refresh claim release") === 1 }
}

export type MarkAiConnectionReauthenticationResult =
  | { marked: true }
  | { marked: false; reason: "connection-not-found" | "already-terminal" }

/**
 * Programmatically moves a connected connection into reauthentication
 * required: credentials cleared, version advanced, refresh claim released.
 *
 * This is the terminal transition for definitive refresh rejections
 * (invalid_grant/401), uncertain refresh outcomes (the request was sent but
 * its result cannot be proven), and stored ciphertexts that no longer
 * authenticate. Unlike a disconnect it does not cancel pending device
 * authorization sessions — those die on their own version guard, and the
 * owner may be mid-reauthorization precisely because of this transition.
 *
 * When `claimId` is given the transition is restricted to that claim holder
 * (or a claim-free row), so it can never clear a concurrently acquired
 * holder's claim. The write is conditional on the connected state, so
 * repeated transitions do not double-advance the version.
 */
export async function markAiConnectionReauthenticationRequired(
  database: D1Database,
  input: { connectionId: string; claimId?: string; now: number },
): Promise<MarkAiConnectionReauthenticationResult> {
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (input.claimId !== undefined && !isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI credential refresh claim id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI credential transition time")

  const result = await database
    .prepare(
      `UPDATE "ai_connections"
       SET "authorizationStatus" = 'reauthentication_required',
           "credentialCiphertext" = NULL,
           "credentialExpiresAt" = NULL,
           "refreshClaimId" = NULL,
           "refreshClaimExpiresAt" = NULL,
           "credentialVersion" = "credentialVersion" + 1,
           "updatedAt" = ?3
       WHERE "id" = ?1
         AND "authorizationStatus" = 'connected'
         AND (
           ?2 IS NULL
           OR "refreshClaimId" IS NULL
           OR "refreshClaimId" = ?2
         )`,
    )
    .bind(input.connectionId, input.claimId ?? null, input.now)
    .run()

  const changes = readChanges(result, "reauthentication transition")
  if (changes === 1) return { marked: true }
  const connection = await getAiConnection(database, input.connectionId)
  if (connection === null) {
    return { marked: false, reason: "connection-not-found" }
  }
  return { marked: false, reason: "already-terminal" }
}

/**
 * Persists a refreshed credential package. The write is conditional on the
 * claim still being valid, this claim's ownership, and the credential version
 * observed when the claim was acquired, so a disconnect, reauthorization,
 * another refresher's commit, or an expired claim rejects the late result
 * instead of overwriting the new state. A claim that reached its expiry is
 * invalid: the refresh outcome is then uncertain and the connection must go
 * through reauthentication rather than persisting a late result.
 */
export async function commitAiCredentialRefresh(
  database: D1Database,
  input: {
    connectionId: string
    claimId: string
    observedCredentialVersion: number
    credentialCiphertext: string
    credentialExpiresAt: number
    now: number
  },
): Promise<AiCredentialRefreshCommitResult> {
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI credential refresh claim id is invalid.")
  }
  if (
    !Number.isSafeInteger(input.observedCredentialVersion) ||
    input.observedCredentialVersion < 0
  ) {
    throw new RangeError("The AI credential version is invalid.")
  }
  if (
    input.credentialCiphertext.length < 1 ||
    input.credentialCiphertext.length > 4096
  ) {
    throw new RangeError("The AI credential ciphertext is invalid.")
  }
  requireEpochMilliseconds(
    input.credentialExpiresAt,
    "The AI credential expiry",
  )
  requireEpochMilliseconds(input.now, "The AI credential commit time")

  const result = await database
    .prepare(
      `UPDATE "ai_connections"
       SET "credentialCiphertext" = ?3,
           "credentialExpiresAt" = ?4,
           "credentialVersion" = "credentialVersion" + 1,
           "refreshClaimId" = NULL,
           "refreshClaimExpiresAt" = NULL,
           "updatedAt" = ?5
       WHERE "id" = ?1
         AND "authorizationStatus" = 'connected'
         AND "credentialVersion" = ?2
         AND "refreshClaimId" = ?6
         AND "refreshClaimExpiresAt" > ?5`,
    )
    .bind(
      input.connectionId,
      input.observedCredentialVersion,
      input.credentialCiphertext,
      input.credentialExpiresAt,
      input.now,
      input.claimId,
    )
    .run()

  if (readChanges(result, "refresh commit") === 1) {
    return { committed: true }
  }

  const connection = await getAiConnection(database, input.connectionId)
  if (connection === null)
    return { committed: false, reason: "connection-not-found" }
  if (connection.credentialVersion !== input.observedCredentialVersion) {
    return { committed: false, reason: "credential-version-changed" }
  }
  if (connection.refreshClaimId !== input.claimId) {
    return { committed: false, reason: "refresh-claim-not-held" }
  }
  if (
    connection.refreshClaimExpiresAt === null ||
    connection.refreshClaimExpiresAt <= input.now
  ) {
    return { committed: false, reason: "refresh-claim-expired" }
  }
  return { committed: false, reason: "credential-state-changed" }
}

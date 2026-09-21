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
import {
  AI_CREDENTIAL_REFRESH_LEAD_MS,
  AI_CREDENTIAL_REFRESH_NETWORK_BUDGET_MS,
  type AiClock,
} from "./policy"
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
  /**
   * Wall clock for decisions taken after an asynchronous step. Defaults to
   * `Date.now`; tests inject their own so a synthetic timeline stays
   * consistent with the rows they seeded.
   */
  clock?: AiClock
}

export interface AiCredentialAccessRequest {
  connectionId: string
  /** Absolute end of the credential stage; never moved by a refresh. */
  deadlineAt: number
  /**
   * The entry time of this stage: the reference for the state read at entry
   * (the freshness decision and the claim's TTL start). Every decision made
   * after an upstream call — claim and session expiry, the remaining budget,
   * the values written by the final conditional writes — reads the context
   * clock instead, so a slow upstream can neither extend the stage budget nor
   * commit against an expired claim.
   */
  now: number
  signal?: AbortSignal
  /** Shared stage budget; when absent the refresh uses its own 10-second cap. */
  upstream?: AiStageUpstreamBudget
  /**
   * Forces the single-writer refresh path even when the recorded expiry still
   * looks valid. The inference transport uses it after an upstream 401 proved
   * the recorded token wrong; the claim, commit, and uncertainty rules are
   * identical to a scheduled refresh.
   */
  forceRefresh?: boolean
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

/**
 * Clears the credential and requires reauthentication, bound to the credential
 * version this attempt observed. A transition that lost to a concurrent writer
 * (a reauthorization or another claim holder) must not clear the credentials
 * that won, so the surviving state is read back and reported instead.
 */
async function requireReauthentication(
  context: AiCredentialServiceContext,
  input: {
    connectionId: string
    claimId?: string
    observedCredentialVersion: number
    now: number
    reason: AiReauthenticationReason
  },
): Promise<AiCredentialAccessResult> {
  const marked = await markAiConnectionReauthenticationRequired(
    context.database,
    {
      claimId: input.claimId,
      connectionId: input.connectionId,
      now: input.now,
      observedCredentialVersion: input.observedCredentialVersion,
    },
  )
  if (marked.marked) {
    return { status: "reauthentication-required", reason: input.reason }
  }
  return classifySurvivingCredentialState(context, {
    connectionId: input.connectionId,
    now: input.now,
  })
}

/**
 * The commit or the reauthentication transition lost to a concurrent writer or
 * a state transition. Re-read the row and classify what actually happened;
 * never retry the network call with the same possibly-consumed refresh token.
 */
async function classifySurvivingCredentialState(
  context: AiCredentialServiceContext,
  input: { connectionId: string; now: number },
): Promise<AiCredentialAccessResult> {
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
  // Every decision taken after an await reads this clock, never the stage's
  // entry time: a slow upstream must not be able to extend the stage budget or
  // commit against an expired claim.
  const clock = context.clock ?? Date.now
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
    return requireReauthentication(context, {
      connectionId: connection.id,
      observedCredentialVersion: connection.credentialVersion,
      now: clock(),
      reason: "ciphertext-unreadable",
    })
  }

  if (
    request.forceRefresh !== true &&
    connection.credentialExpiresAt > request.now + AI_CREDENTIAL_REFRESH_LEAD_MS
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
        : Math.max(1_000, claimed.refreshClaimExpiresAt - clock())
    return { status: "credential-busy", retryAfterMs: remaining }
  }

  // The claim's own snapshot is authoritative for this refresh attempt.
  const claimedConnection = claimed.connection
  const claimedStored = await readStoredPackage(context, claimedConnection)
  if (!claimedStored.ok) {
    return requireReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      observedCredentialVersion: claimedConnection.credentialVersion,
      now: clock(),
      reason: "ciphertext-unreadable",
    })
  }

  // The stage deadline is absolute; the remaining budget is measured against
  // the current clock so time already spent cannot extend it.
  const remainingBudget = request.deadlineAt - clock()
  if (remainingBudget <= 0) {
    // The refresh provably never reached the upstream: the budget was
    // exhausted before the fetch call. Release the claim and keep the
    // credential for a later retry.
    await releaseAiCredentialRefreshClaim(context.database, {
      claimId,
      connectionId: claimedConnection.id,
      now: clock(),
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
        now: clock(),
      })
      return { status: "upstream-unavailable" }
    }
    refreshResult = attempt.value
  }

  if (!refreshResult.ok) {
    if (isDefinitiveCodexRefreshRejection(refreshResult.failure)) {
      return requireReauthentication(context, {
        claimId,
        connectionId: claimedConnection.id,
        observedCredentialVersion: claimedConnection.credentialVersion,
        now: clock(),
        reason: "invalid-grant",
      })
    }
    // The request was sent but its outcome is unprovable: the refresh token
    // may already have been rotated upstream. Never replay it.
    return requireReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      observedCredentialVersion: claimedConnection.credentialVersion,
      now: clock(),
      reason: "refresh-outcome-unknown",
    })
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
    return requireReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      observedCredentialVersion: claimedConnection.credentialVersion,
      now: clock(),
      reason: "token-response-invalid",
    })
  }
  // The refreshed token was issued now, so its lifetime is measured from the
  // current clock; the absolute stage deadline above is unaffected.
  const refreshedAt = clock()
  const expiry = deriveCredentialExpiry({
    expiresIn: refreshResult.value.expiresIn,
    mergedAccessToken: merged.accessToken,
    now: refreshedAt,
    previousAccessToken: claimedStored.package.accessToken,
    previousExpiresAt: claimedConnection.credentialExpiresAt ?? refreshedAt,
  })
  if (expiry === null || expiry <= refreshedAt) {
    return requireReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      observedCredentialVersion: claimedConnection.credentialVersion,
      now: refreshedAt,
      reason: "token-response-invalid",
    })
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
      return requireReauthentication(context, {
        claimId,
        connectionId: claimedConnection.id,
        observedCredentialVersion: claimedConnection.credentialVersion,
        now: clock(),
        reason: "ciphertext-unreadable",
      })
    }
    throw error
  }

  // The commit's claim-expiry guard must be judged against the current clock:
  // the refresh spent real time, and an expired claim makes the outcome
  // uncertain rather than persisting a late result.
  const committed = await commitAiCredentialRefresh(context.database, {
    claimId,
    connectionId: claimedConnection.id,
    credentialCiphertext: mergedCiphertext,
    credentialExpiresAt: expiry,
    now: clock(),
    observedCredentialVersion: claimedConnection.credentialVersion,
  })
  if (committed.committed) {
    // The commit returned the row exactly as this refresh wrote it: this
    // token, its expiry, the cleared claim, and the version this write
    // created are one consistent snapshot. A reauthorization that completed
    // after the statement cannot substitute its state into the result — the
    // replay of this refresh's token stays bound to this refresh's version,
    // so its rejection can never invalidate the newer credential.
    return {
      status: "usable",
      accountId: committed.connection.upstreamAccountId,
      accessToken: merged.accessToken,
      connection: committed.connection,
    }
  }
  if (committed.reason === "refresh-claim-expired") {
    // The claim reached its expiry during the refresh: the outcome is
    // uncertain and the connection must go through reauthorization.
    return requireReauthentication(context, {
      claimId,
      connectionId: claimedConnection.id,
      observedCredentialVersion: claimedConnection.credentialVersion,
      now: clock(),
      reason: "refresh-claim-expired",
    })
  }
  return classifySurvivingCredentialState(context, {
    connectionId: claimedConnection.id,
    now: clock(),
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

import {
  AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
  AI_AUTHORIZATION_POLL_DEFAULT_INTERVAL_MS,
  AI_RECENT_AUTHORIZATION_WINDOW_MS,
} from "../../shared/ai"
import { completeAiAuthorization } from "./authorizations"
import {
  cancelAiAuthorizationSession,
  claimAiAuthorizationPoll,
  createAiAuthorizationSession,
  getAiAuthorizationSession,
  releaseAiAuthorizationPoll,
  type AiAuthorizationSessionRecord,
} from "./authorizations"
import {
  CODEX_PROVIDER_TYPE,
  exchangeCodexAuthorizationCode,
  getCodexProviderDefinition,
  pollCodexDeviceAuthorization,
  readCodexAccessTokenExpiryMs,
  requestCodexDeviceUserCode,
  verifyCodexIdToken,
} from "./codex-connector"
import { getAiConnection } from "./connections"
import {
  decryptAiSecret,
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "./credential-cipher"
import type { AiCredentialServiceContext } from "./credential-lifecycle"
import {
  AI_CREDENTIAL_DEFAULT_LIFETIME_MS,
  readCodexCredentialPackage,
} from "./credential-lifecycle"
import { AiStageUpstreamBudget } from "./stage-budget"

/**
 * Owner-facing device authorization orchestration for the Codex connector.
 *
 * The durable session bookkeeping (owner/session binding, version binding,
 * single-winner poll claims, atomic completion) is the PR 2 storage layer;
 * this module adds the upstream dialogue and the completion guard rails:
 *
 * - One upstream status check per poll request, honoring nextPollAt and the
 *   upstream interval.
 * - The authorization code is exchanged and the ID token verified (JWKS,
 *   issuer, audience, expiry) before anything is persisted.
 * - Immediately before the credential commit the flow re-reads the owner's
 *   persistent session: recent authentication, not revoked. The same
 *   request's earlier checks never substitute for this recheck.
 * - Reauthorization must keep the original account and workspace: the
 *   workspace is guarded atomically by the completion write; the ChatGPT
 *   user identity is compared against the stored package right before it.
 * - Cancellation, logout, expiry, disconnect, deletion, and version changes
 *   all end in the storage layer's guards rejecting the late write.
 *
 * Audit events are emitted through a caller-provided sink so this layer stays
 * free of request plumbing; the sink is fire-and-forget and its failures
 * never replay a mutation. Pending polls write no audit.
 */

export type AiAuthorizationAuditEventType =
  | "ai_authorization_started"
  | "ai_authorization_completed"
  | "ai_authorization_cancelled"

export interface AiAuthorizationAuditEvent {
  type: AiAuthorizationAuditEventType
  outcome: "success" | "failure"
  subjectId: string
  metadata: { connectionId: string; providerType: string }
}

export type AiAuthorizationAuditSink = (
  event: AiAuthorizationAuditEvent,
) => void

export interface AiAuthorizationFlowContext extends AiCredentialServiceContext {
  audit: AiAuthorizationAuditSink
}

export interface AiAuthorizationStageBudget {
  now: number
  deadlineAt: number
  signal?: AbortSignal
}

export type StartCodexAuthorizationResult =
  | {
      status: "started"
      authorizationId: string
      verificationUrl: string
      userCode: string
      intervalMs: number
      expiresAt: number
    }
  | { status: "connection-not-found" }
  | { status: "provider-unsupported" }
  | {
      status: "upstream-failure"
      reason: "unavailable" | "rejected" | "protocol"
    }

export async function startCodexAuthorization(
  context: AiAuthorizationFlowContext,
  input: {
    connectionId: string
    ownerUserId: string
    ownerSessionId: string
  } & AiAuthorizationStageBudget,
): Promise<StartCodexAuthorizationResult> {
  const connection = await getAiConnection(context.database, input.connectionId)
  if (connection === null) return { status: "connection-not-found" }
  if (connection.providerType !== CODEX_PROVIDER_TYPE) {
    return { status: "provider-unsupported" }
  }

  const emit = (outcome: "success" | "failure"): void =>
    context.audit({
      metadata: {
        connectionId: connection.id,
        providerType: connection.providerType,
      },
      outcome,
      subjectId: input.ownerUserId,
      type: "ai_authorization_started",
    })

  const budget = new AiStageUpstreamBudget({ deadlineAt: input.deadlineAt })
  const userCodeAttempt = await budget.withinBudget((options) =>
    requestCodexDeviceUserCode({
      signal: input.signal,
      timeoutMs: options.timeoutMs,
    }),
  )
  if (!userCodeAttempt.ok) {
    emit("failure")
    return { status: "upstream-failure", reason: "unavailable" }
  }
  const userCode = userCodeAttempt.value
  if (!userCode.ok) {
    emit("failure")
    if (userCode.failure.kind === "network") {
      return { status: "upstream-failure", reason: "unavailable" }
    }
    if (userCode.failure.kind === "http") {
      return { status: "upstream-failure", reason: "rejected" }
    }
    return { status: "upstream-failure", reason: "protocol" }
  }

  const authorizationId = crypto.randomUUID()
  let deviceGrantCiphertext: string
  try {
    const keyring = await parseAiCredentialKeyring(context.credentialKeys)
    deviceGrantCiphertext = await encryptAiSecret(
      keyring,
      JSON.stringify({
        deviceAuthId: userCode.value.deviceAuthId,
        intervalMs: userCode.value.intervalMs,
        userCode: userCode.value.userCode,
      }),
      {
        connectionId: connection.id,
        environment: context.environment,
        providerType: connection.providerType,
        purpose: "device-grant",
      },
    )
  } catch {
    // Without a usable keyring the temporary grant cannot be stored safely;
    // nothing is persisted and the owner sees a controlled failure.
    emit("failure")
    return { status: "upstream-failure", reason: "unavailable" }
  }

  const created = await createAiAuthorizationSession(context.database, {
    connectionId: connection.id,
    deviceGrantCiphertext,
    id: authorizationId,
    ownerSessionId: input.ownerSessionId,
    ownerUserId: input.ownerUserId,
    pollIntervalMs: userCode.value.intervalMs,
    sessionTtlMs: AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
    now: input.now,
  })
  if (!created.created) {
    emit("failure")
    return { status: "connection-not-found" }
  }

  emit("success")
  return {
    authorizationId,
    expiresAt: created.session.expiresAt,
    intervalMs: userCode.value.intervalMs,
    status: "started",
    userCode: userCode.value.userCode,
    verificationUrl: getCodexProviderDefinition().deviceVerificationUrl,
  }
}

interface AiDeviceGrantPayload {
  deviceAuthId: string
  intervalMs: number
  userCode: string
}

async function decryptDeviceGrant(
  context: AiCredentialServiceContext,
  session: AiAuthorizationSessionRecord,
): Promise<AiDeviceGrantPayload | null> {
  try {
    const keyring = await parseAiCredentialKeyring(context.credentialKeys)
    const plaintext = await decryptAiSecret(
      keyring,
      session.deviceGrantCiphertext,
      {
        connectionId: session.connectionId,
        environment: context.environment,
        providerType: CODEX_PROVIDER_TYPE,
        purpose: "device-grant",
      },
    )
    const parsed = JSON.parse(plaintext) as Partial<AiDeviceGrantPayload>
    const intervalMs = parsed.intervalMs
    if (
      typeof parsed.deviceAuthId !== "string" ||
      parsed.deviceAuthId === "" ||
      typeof parsed.userCode !== "string" ||
      parsed.userCode === "" ||
      intervalMs === undefined ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs <= 0
    ) {
      return null
    }
    return {
      deviceAuthId: parsed.deviceAuthId,
      intervalMs,
      userCode: parsed.userCode,
    }
  } catch {
    return null
  }
}

interface OwnerSessionAuthenticationState {
  present: boolean
  recentAuthentication: boolean
}

async function readOwnerSessionAuthenticationState(
  context: AiCredentialServiceContext,
  input: { ownerSessionId: string; ownerUserId: string; now: number },
): Promise<OwnerSessionAuthenticationState> {
  const row = await context.database
    .prepare(
      'SELECT "userId", "expiresAt", "reauthenticatedAt" FROM "session" WHERE "id" = ?1',
    )
    .bind(input.ownerSessionId)
    .first<{
      expiresAt: string
      reauthenticatedAt: string
      userId: string
    }>()
  if (row === null) return { present: false, recentAuthentication: false }
  // Defense in depth: the row must belong to the bound owner user, not just
  // exist under the recorded session id.
  if (row.userId !== input.ownerUserId) {
    return { present: false, recentAuthentication: false }
  }
  const expiresAt = new Date(row.expiresAt).getTime()
  const reauthenticatedAt = new Date(row.reauthenticatedAt).getTime()
  const notExpired = Number.isFinite(expiresAt) && expiresAt > input.now
  const recent =
    Number.isFinite(reauthenticatedAt) &&
    reauthenticatedAt <= input.now &&
    input.now - reauthenticatedAt <= AI_RECENT_AUTHORIZATION_WINDOW_MS
  return { present: true, recentAuthentication: notExpired && recent }
}

export type PollCodexAuthorizationResult =
  | { status: "pending"; intervalMs: number; nextPollAt: number }
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "poll-too-early"; nextPollAt: number }
  | { status: "poll-claim-held" }
  | { status: "session-mismatch" }
  | { status: "connection-changed" }
  | { status: "authorization-not-found" }
  | { status: "upstream-unavailable" }
  | { status: "rejected" }
  | { status: "invalid-identity" }
  | { status: "account-mismatch" }
  | { status: "recent-authentication-required" }
  | { status: "owner-session-revoked" }

/** Claim-rejection statuses that carry no payload in the poll result. */
type PollClaimRejectionStatus = Exclude<
  PollCodexAuthorizationResult["status"],
  "pending" | "poll-too-early"
>

function mapPollRejectionReason(reason: string): PollClaimRejectionStatus {
  switch (reason) {
    case "session-not-found":
      return "authorization-not-found"
    case "owner-session-mismatch":
      return "session-mismatch"
    case "session-not-pending":
      return "completed"
    case "session-expired":
      return "expired"
    case "poll-claim-held":
      return "poll-claim-held"
    case "connection-missing":
      return "connection-changed"
    case "connection-version-changed":
      return "connection-changed"
  }
  return "poll-claim-held"
}

async function releasePollClaim(
  context: AiCredentialServiceContext,
  input: {
    session: AiAuthorizationSessionRecord
    claimId: string
    nextPollAt: number
    now: number
  },
): Promise<void> {
  await releaseAiAuthorizationPoll(context.database, {
    claimId: input.claimId,
    // releaseAiAuthorizationPoll requires nextPollAt >= now; callers pass
    // input.now for immediate retry or now + interval after a real check.
    nextPollAt: Math.max(input.nextPollAt, input.now),
    now: input.now,
    sessionId: input.session.id,
  })
}

async function cancelSession(
  context: AiCredentialServiceContext,
  session: AiAuthorizationSessionRecord,
  now: number,
): Promise<void> {
  await cancelAiAuthorizationSession(context.database, {
    now,
    ownerSessionId: session.ownerSessionId,
    ownerUserId: session.ownerUserId,
    sessionId: session.id,
  })
}

export async function pollCodexAuthorization(
  context: AiAuthorizationFlowContext,
  input: {
    authorizationId: string
    ownerUserId: string
    ownerSessionId: string
  } & AiAuthorizationStageBudget,
): Promise<PollCodexAuthorizationResult> {
  const claimId = crypto.randomUUID()
  const claimed = await claimAiAuthorizationPoll(context.database, {
    claimId,
    now: input.now,
    ownerSessionId: input.ownerSessionId,
    ownerUserId: input.ownerUserId,
    sessionId: input.authorizationId,
  })

  if (!claimed.claimed) {
    if (claimed.reason === "poll-too-early") {
      const session = await getAiAuthorizationSession(
        context.database,
        input.authorizationId,
      )
      if (session !== null && session.status === "pending") {
        return { status: "poll-too-early", nextPollAt: session.nextPollAt }
      }
      return { status: "expired" }
    }
    const mapped = mapPollRejectionReason(claimed.reason)
    if (mapped === "completed" || mapped === "cancelled") {
      // Distinguish the terminal states the session actually reached.
      const session = await getAiAuthorizationSession(
        context.database,
        input.authorizationId,
      )
      if (session === null) return { status: "authorization-not-found" }
      return session.status === "completed"
        ? { status: "completed" }
        : { status: "cancelled" }
    }
    return { status: mapped }
  }

  const session = claimed.session
  const connection = await getAiConnection(
    context.database,
    session.connectionId,
  )
  if (connection === null || connection.providerType !== CODEX_PROVIDER_TYPE) {
    // The claim guard proved the version binding at claim time; a vanished
    // connection cannot be completed. Drop the claim for an immediate retry.
    await releasePollClaim(context, {
      claimId,
      nextPollAt: input.now,
      now: input.now,
      session,
    })
    return { status: "connection-changed" }
  }

  const emitCompletion = (outcome: "success" | "failure"): void =>
    context.audit({
      metadata: {
        connectionId: connection.id,
        providerType: connection.providerType,
      },
      outcome,
      subjectId: session.ownerUserId,
      type: "ai_authorization_completed",
    })

  const budget = new AiStageUpstreamBudget({ deadlineAt: input.deadlineAt })

  const deviceGrant = await decryptDeviceGrant(context, session)
  if (deviceGrant === null) {
    // The stored grant is unreadable; the session can never complete.
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "rejected" }
  }

  const pollAttempt = await budget.withinBudget((options) =>
    pollCodexDeviceAuthorization(
      {
        deviceAuthId: deviceGrant.deviceAuthId,
        userCode: deviceGrant.userCode,
      },
      { signal: input.signal, timeoutMs: options.timeoutMs },
    ),
  )
  if (!pollAttempt.ok) {
    await releasePollClaim(context, {
      claimId,
      nextPollAt: input.now,
      now: input.now,
      session,
    })
    return { status: "upstream-unavailable" }
  }
  const pollResult = pollAttempt.value
  if (!pollResult.ok) {
    if (pollResult.failure.kind === "network") {
      // A status check is read-only: release the claim so the next poll can
      // retry after the interval, and report the transient failure.
      await releasePollClaim(context, {
        claimId,
        nextPollAt: input.now + deviceGrant.intervalMs,
        now: input.now,
        session,
      })
      return { status: "upstream-unavailable" }
    }
    // A protocol failure on a 2xx payload or any other HTTP outcome is
    // terminal for this authorization attempt per the fixed reference: the
    // grant was denied or invalidated upstream.
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "rejected" }
  }
  if (pollResult.value.status === "pending") {
    await releasePollClaim(context, {
      claimId,
      nextPollAt: input.now + deviceGrant.intervalMs,
      now: input.now,
      session,
    })
    return {
      status: "pending",
      intervalMs: deviceGrant.intervalMs,
      nextPollAt: input.now + deviceGrant.intervalMs,
    }
  }

  // Authorized: exchange the one-time code for the credential package.
  const { authorizationCode, codeVerifier } = pollResult.value
  const exchangeAttempt = await budget.withinBudget((options) =>
    exchangeCodexAuthorizationCode(
      { authorizationCode, codeVerifier },
      { signal: input.signal, timeoutMs: options.timeoutMs },
    ),
  )
  if (!exchangeAttempt.ok) {
    // The budget ran out before the exchange was sent. Nothing was consumed
    // yet; the session stays pending and the client may poll again after
    // reading the persistent state.
    await releasePollClaim(context, {
      claimId,
      nextPollAt: input.now,
      now: input.now,
      session,
    })
    return { status: "upstream-unavailable" }
  }
  const exchanged = exchangeAttempt.value
  if (!exchanged.ok) {
    // The code is consumed or its exchange outcome is unknowable; this
    // authorization session can never complete. Cancel it terminally.
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "rejected" }
  }

  const verificationAttempt = await budget.withinBudget((options) =>
    verifyCodexIdToken(exchanged.value.idToken, {
      signal: input.signal,
      timeoutMs: options.timeoutMs,
    }),
  )
  if (!verificationAttempt.ok) {
    // The code was consumed but the identity cannot be verified within this
    // stage; the authorization attempt terminally failed.
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "rejected" }
  }
  const identity = verificationAttempt.value
  if (!identity.ok) {
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "invalid-identity" }
  }
  // Reauthorization must keep the original account and workspace. The
  // workspace is compared against the live row and then guarded atomically
  // by the completion write; the ChatGPT user identity is compared against
  // the stored package right before the commit. An unreadable old package
  // does not block the repair — the workspace column still binds the match.
  const freshConnection = await getAiConnection(context.database, connection.id)
  if (freshConnection === null) {
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "connection-changed" }
  }
  if (
    freshConnection.upstreamAccountId !== null &&
    freshConnection.upstreamAccountId !== identity.value.chatgptAccountId
  ) {
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "account-mismatch" }
  }
  if (freshConnection.credentialCiphertext !== null) {
    const storedPackage = await readCodexCredentialPackage(
      context,
      freshConnection,
    )
    if (
      storedPackage !== null &&
      storedPackage.chatgptUserId !== null &&
      identity.value.chatgptUserId !== storedPackage.chatgptUserId
    ) {
      await cancelSession(context, session, input.now)
      emitCompletion("failure")
      return { status: "account-mismatch" }
    }
  }

  // Pre-commit recheck of the owner's persistent session: recent
  // authentication and not revoked, read fresh from D1. Earlier identity
  // checks in this request never substitute for this read.
  const authentication = await readOwnerSessionAuthenticationState(context, {
    now: input.now,
    ownerSessionId: session.ownerSessionId,
    ownerUserId: session.ownerUserId,
  })
  if (!authentication.present) {
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "owner-session-revoked" }
  }
  if (!authentication.recentAuthentication) {
    // The session stays pending: after a fresh reauthentication the owner
    // may poll again while the grant is still live.
    await releasePollClaim(context, {
      claimId,
      nextPollAt: input.now + deviceGrant.intervalMs,
      now: input.now,
      session,
    })
    return { status: "recent-authentication-required" }
  }

  const completionId = crypto.randomUUID()
  const credentialExpiry =
    exchanged.value.expiresIn !== undefined
      ? input.now + exchanged.value.expiresIn * 1_000
      : (readCodexAccessTokenExpiryMs(exchanged.value.accessToken) ??
        input.now + AI_CREDENTIAL_DEFAULT_LIFETIME_MS)
  let credentialCiphertext: string
  try {
    const keyring = await parseAiCredentialKeyring(context.credentialKeys)
    credentialCiphertext = await encryptAiSecret(
      keyring,
      JSON.stringify({
        accessToken: exchanged.value.accessToken,
        chatgptUserId: identity.value.chatgptUserId,
        refreshToken: exchanged.value.refreshToken,
      }),
      {
        connectionId: freshConnection.id,
        environment: context.environment,
        providerType: freshConnection.providerType,
        purpose: "credential-package",
      },
    )
  } catch {
    await cancelSession(context, session, input.now)
    emitCompletion("failure")
    return { status: "rejected" }
  }

  const completion = await completeAiAuthorization(context.database, {
    claimId,
    completionId,
    credentialCiphertext,
    credentialExpiresAt: credentialExpiry,
    now: input.now,
    sessionId: session.id,
    upstreamAccountId: identity.value.chatgptAccountId,
  })
  if (completion.completed) {
    emitCompletion("success")
    return { status: "completed" }
  }

  // The atomic guards rejected the late write (expired session, revoked
  // owner session, disconnect, reauthorization, or account change raced the
  // completion). Classify the surviving state for the caller: a connection
  // that moved on (deleted or re-versioned) explains the rejection on its
  // own; only otherwise does the session's terminal state decide.
  emitCompletion("failure")
  const survivingConnection = await getAiConnection(
    context.database,
    session.connectionId,
  )
  if (
    survivingConnection === null ||
    survivingConnection.credentialVersion !==
      session.connectionCredentialVersion
  ) {
    return { status: "connection-changed" }
  }
  if (completion.reason === "session-not-pending") {
    const survivingSession = await getAiAuthorizationSession(
      context.database,
      session.id,
    )
    if (survivingSession === null) return { status: "authorization-not-found" }
    return survivingSession.status === "completed"
      ? { status: "completed" }
      : { status: "cancelled" }
  }
  switch (completion.reason) {
    case "session-not-found":
      return { status: "authorization-not-found" }
    case "session-expired":
      return { status: "expired" }
    case "owner-session-revoked":
      return { status: "owner-session-revoked" }
    case "upstream-account-mismatch":
      return { status: "account-mismatch" }
    case "claim-not-held":
      return { status: "poll-claim-held" }
  }
  return { status: "poll-claim-held" }
}

export type ReadCodexAuthorizationStatusResult =
  | {
      status: "pending"
      expiresAt: number
      intervalMs: number
      nextPollAt: number
    }
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "session-mismatch" }
  | { status: "authorization-not-found" }
  | { status: "connection-changed" }

/** Reads the authorization state; never triggers an upstream request. */
export async function readCodexAuthorizationStatus(
  context: AiCredentialServiceContext,
  input: {
    authorizationId: string
    ownerUserId: string
    ownerSessionId: string
    now: number
  },
): Promise<ReadCodexAuthorizationStatusResult> {
  const session = await getAiAuthorizationSession(
    context.database,
    input.authorizationId,
  )
  if (session === null) return { status: "authorization-not-found" }
  if (
    session.ownerUserId !== input.ownerUserId ||
    session.ownerSessionId !== input.ownerSessionId
  ) {
    return { status: "session-mismatch" }
  }
  if (session.status === "completed") return { status: "completed" }
  if (session.status === "cancelled") return { status: "cancelled" }
  if (session.expiresAt <= input.now) return { status: "expired" }
  const connection = await getAiConnection(
    context.database,
    session.connectionId,
  )
  if (connection === null) return { status: "connection-changed" }
  if (connection.credentialVersion !== session.connectionCredentialVersion) {
    return { status: "connection-changed" }
  }
  const deviceGrant = await decryptDeviceGrant(context, session)
  return {
    status: "pending",
    expiresAt: session.expiresAt,
    intervalMs:
      deviceGrant?.intervalMs ?? AI_AUTHORIZATION_POLL_DEFAULT_INTERVAL_MS,
    nextPollAt: session.nextPollAt,
  }
}

export type CancelCodexAuthorizationResult =
  | { status: "cancelled" }
  | { status: "session-mismatch" }
  | { status: "authorization-not-found" }

export async function cancelCodexAuthorization(
  context: AiAuthorizationFlowContext,
  input: {
    authorizationId: string
    ownerUserId: string
    ownerSessionId: string
    now: number
  },
): Promise<CancelCodexAuthorizationResult> {
  const session = await getAiAuthorizationSession(
    context.database,
    input.authorizationId,
  )
  if (session === null) {
    return { status: "authorization-not-found" }
  }
  const emit = (outcome: "success" | "failure"): void =>
    context.audit({
      metadata: {
        connectionId: session.connectionId,
        providerType: CODEX_PROVIDER_TYPE,
      },
      outcome,
      subjectId: input.ownerUserId,
      type: "ai_authorization_cancelled",
    })
  if (
    session.ownerUserId !== input.ownerUserId ||
    session.ownerSessionId !== input.ownerSessionId
  ) {
    emit("failure")
    return { status: "session-mismatch" }
  }
  if (session.status !== "pending") {
    // Idempotent: the session already reached a terminal state.
    emit("success")
    return { status: "cancelled" }
  }
  const cancelled = await cancelAiAuthorizationSession(context.database, {
    now: input.now,
    ownerSessionId: input.ownerSessionId,
    ownerUserId: input.ownerUserId,
    sessionId: input.authorizationId,
  })
  emit(cancelled.cancelled ? "success" : "failure")
  return { status: "cancelled" }
}

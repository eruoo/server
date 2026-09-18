/**
 * Shared AI service contracts and the single AI policy source.
 *
 * This module keeps the value domains, connection naming rules, and first-run
 * operational boundaries from docs/specs/ai-service.md §4, §7, and §8 in one
 * place. The worker storage operations, the daily cleanup, and the restore
 * planner read these definitions instead of keeping private copies.
 *
 * Only the durable-state slice is implemented: AI HTTP routes, the AI key
 * profile, and real upstream connectors open in later slices, so nothing here
 * implies the AI service is usable yet.
 */

export const AI_CONNECTIONS_TABLE = "ai_connections"
export const AI_AUTHORIZATION_SESSIONS_TABLE = "ai_authorization_sessions"
export const AI_MODELS_TABLE = "ai_models"
export const AI_INVOCATIONS_TABLE = "ai_invocations"

/** Application tables introduced by the AI service migration. */
export const AI_APPLICATION_TABLES = [
  AI_CONNECTIONS_TABLE,
  AI_AUTHORIZATION_SESSIONS_TABLE,
  AI_MODELS_TABLE,
  AI_INVOCATIONS_TABLE,
] as const

export type AiApplicationTable = (typeof AI_APPLICATION_TABLES)[number]

export const aiProviderTypes = ["openai-codex"] as const
export type AiProviderType = (typeof aiProviderTypes)[number]

export function isAiProviderType(value: string): value is AiProviderType {
  return (aiProviderTypes as readonly string[]).includes(value)
}

export const aiConnectionAuthorizationStatuses = [
  "never_authorized",
  "connected",
  "reauthentication_required",
] as const
export type AiConnectionAuthorizationStatus =
  (typeof aiConnectionAuthorizationStatuses)[number]

export const aiAuthorizationSessionStatuses = [
  "pending",
  "completed",
  "cancelled",
] as const
export type AiAuthorizationSessionStatus =
  (typeof aiAuthorizationSessionStatuses)[number]

export const aiInvocationStatuses = [
  "reserved",
  "succeeded",
  "failed",
  "incomplete",
  "unknown",
] as const
export type AiInvocationStatus = (typeof aiInvocationStatuses)[number]

export const aiTerminalInvocationStatuses = [
  "succeeded",
  "failed",
  "incomplete",
  "unknown",
] as const
export type AiTerminalInvocationStatus =
  (typeof aiTerminalInvocationStatuses)[number]

export function isAiTerminalInvocationStatus(
  status: AiInvocationStatus,
): status is AiTerminalInvocationStatus {
  return (aiTerminalInvocationStatuses as readonly string[]).includes(status)
}

/**
 * Server-generated identifiers (connection, session, request, claim, and
 * completion IDs) are UUIDs. Synthetic test fixtures use the same shape.
 */
const aiServerIdentifierPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isAiServerIdentifier(value: string): boolean {
  return aiServerIdentifierPattern.test(value)
}

/**
 * Connection slugs are immutable and unique among existing connections:
 * 1–64 lowercase ASCII letters or digits with single hyphens as separators,
 * no leading, trailing, or consecutive hyphens.
 */
export const AI_CONNECTION_SLUG_MAX_LENGTH = 64
const aiConnectionSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isAiConnectionSlug(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= AI_CONNECTION_SLUG_MAX_LENGTH &&
    aiConnectionSlugPattern.test(value)
  )
}

/** Device authorization sessions live at most 15 minutes. */
export const AI_AUTHORIZATION_SESSION_MAX_TTL_MS = 15 * 60 * 1000

/** Poll intervals never fall below 1 second. */
export const AI_AUTHORIZATION_POLL_MIN_INTERVAL_MS = 1_000

/** A poll claim coordinates one upstream status check per poll request. */
export const AI_AUTHORIZATION_POLL_CLAIM_TTL_MS = 30_000

/** Refresh claim retention, including the 10-second refresh network budget. */
export const AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS = 30_000

/** Access tokens are refreshed 60 seconds before they expire. */
export const AI_CREDENTIAL_REFRESH_LEAD_MS = 60_000

/** Service-wide and per-key in-flight invocation slots. */
export const AI_MAX_IN_FLIGHT_INVOCATIONS = 2
export const AI_MAX_IN_FLIGHT_INVOCATIONS_PER_KEY = 1

/** Reservations survive the request deadline by 30 seconds for terminal writes. */
export const AI_INVOCATION_RESERVATION_GRACE_MS = 30_000

/** Invocation metadata is queryable and physically cleaned after 30 days. */
export const AI_INVOCATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const AI_INVOCATION_HISTORY_DEFAULT_LIMIT = 50
export const AI_INVOCATION_HISTORY_MAX_LIMIT = 100

function requireSafeEpochMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be safe epoch milliseconds.`)
  }
  return value
}

/**
 * Shared 30-day invocation retention boundary: history reads filter with this
 * cutoff and the daily cleanup deletes with the same cutoff, so physical
 * cleanup backlog never changes what reads observe.
 */
export function createAiInvocationRetentionCutoff(
  nowMilliseconds: number,
): number {
  const now = requireSafeEpochMilliseconds(
    nowMilliseconds,
    "AI invocation retention boundary",
  )
  const cutoff = now - AI_INVOCATION_RETENTION_MS
  if (!Number.isSafeInteger(cutoff)) {
    throw new RangeError("AI invocation retention boundary is invalid.")
  }
  return cutoff
}

/** The reservation lease releases quota only after the terminal-write window. */
export function createAiInvocationLeaseExpiry(deadlineAt: number): number {
  const deadline = requireSafeEpochMilliseconds(
    deadlineAt,
    "AI invocation lease expiry",
  )
  const leaseExpiresAt = deadline + AI_INVOCATION_RESERVATION_GRACE_MS
  if (!Number.isSafeInteger(leaseExpiresAt)) {
    throw new RangeError("AI invocation lease expiry is invalid.")
  }
  return leaseExpiresAt
}

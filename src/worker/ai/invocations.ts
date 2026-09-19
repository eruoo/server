import {
  AI_INVOCATION_HISTORY_DEFAULT_LIMIT,
  AI_INVOCATION_HISTORY_MAX_LIMIT,
  AI_MAX_IN_FLIGHT_INVOCATIONS,
  AI_MAX_IN_FLIGHT_INVOCATIONS_PER_KEY,
  createAiInvocationLeaseExpiry,
  createAiInvocationRetentionCutoff,
  isAiServerIdentifier,
  isAiTerminalInvocationStatus,
  type AiInvocationStatus,
  type AiTerminalInvocationStatus,
} from "../../shared/ai"

/**
 * Durable invocation admission, terminal writes, and bounded history reads.
 *
 * Admission is a single conditional INSERT that checks the service-wide and
 * per-key in-flight quotas in the same write; a full quota inserts nothing and
 * never waits. Reservations hold their slot until the request deadline plus
 * the terminal-write grace period, and a reservation whose lease expired
 * without a terminal record is read back as unknown — never as success, and
 * missing usage stays missing instead of becoming a fabricated zero.
 */

export interface AiInvocationRecord {
  requestId: string
  apiKeyId: string
  /** Null while a reservation has not been identified yet. */
  connectionId: string | null
  upstreamModelId: string | null
  startedAt: number
  deadlineAt: number
  leaseExpiresAt: number
  status: AiInvocationStatus
  /** reserved rows past their lease are reported as unknown. */
  effectiveStatus: AiInvocationStatus
  endedAt: number | null
  errorCode: string | null
  upstreamRequestId: string | null
  usage: string | null
}

export type ReserveAiInvocationResult =
  | { reserved: true }
  | {
      reserved: false
      reason: "service-quota-exceeded" | "key-quota-exceeded"
    }

export type AssignAiInvocationIdentityResult =
  | { assigned: true }
  | {
      assigned: false
      reason:
        | "invocation-not-found"
        | "invocation-not-reserved"
        | "invocation-already-identified"
    }

export type ReleaseAiInvocationReservationResult =
  | { released: true }
  | {
      released: false
      reason:
        | "invocation-not-found"
        | "invocation-not-reserved"
        | "invocation-already-identified"
    }

export type CommitAiInvocationOutcomeResult =
  | { committed: true }
  | {
      committed: false
      reason: "invocation-not-found" | "invocation-already-terminal"
    }

export interface AiInvocationHistoryCursor {
  startedAt: number
  requestId: string
}

export interface AiInvocationHistoryPage {
  records: AiInvocationRecord[]
  nextCursor: AiInvocationHistoryCursor | null
}

const AI_INVOCATION_API_KEY_ID_MAX_LENGTH = 64
const AI_INVOCATION_UPSTREAM_MODEL_ID_MAX_LENGTH = 200
const AI_INVOCATION_ERROR_CODE_MAX_LENGTH = 128
const AI_INVOCATION_UPSTREAM_REQUEST_ID_MAX_LENGTH = 128
const AI_INVOCATION_USAGE_MAX_LENGTH = 4096

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
    throw new TypeError(`The AI invocation ${operation} result is invalid.`)
  }
  return changes
}

interface AiInvocationRow {
  requestId: string
  apiKeyId: string
  connectionId: string | null
  upstreamModelId: string | null
  startedAt: number
  deadlineAt: number
  leaseExpiresAt: number
  status: AiInvocationStatus
  endedAt: number | null
  errorCode: string | null
  upstreamRequestId: string | null
  usage: string | null
}

function toAiInvocationRecord(
  row: AiInvocationRow,
  now: number,
): AiInvocationRecord {
  return {
    ...row,
    effectiveStatus:
      row.status === "reserved" && row.leaseExpiresAt <= now
        ? "unknown"
        : row.status,
  }
}

export async function readAiInvocation(
  database: D1Database,
  requestId: string,
  now: number,
): Promise<AiInvocationRecord | null> {
  if (!isAiServerIdentifier(requestId)) {
    throw new RangeError("The AI invocation request id is invalid.")
  }
  requireEpochMilliseconds(now, "The AI invocation read time")
  // Single-row reads share the list-read retention boundary, so physical
  // cleanup backlog can never resurface a row past the 30-day cutoff; the
  // boundary itself stays readable.
  const retentionCutoff = createAiInvocationRetentionCutoff(now)
  const row = await database
    .prepare(
      'SELECT * FROM "ai_invocations" WHERE "requestId" = ?1 AND "startedAt" >= ?2',
    )
    .bind(requestId, retentionCutoff)
    .first<AiInvocationRow>()
  return row === null ? null : toAiInvocationRecord(row, now)
}

/**
 * Takes an in-flight invocation slot before the request body is read. The
 * service-wide limit and the per-key limit are enforced by the same
 * conditional INSERT — there is no read-then-insert window — and only rows
 * whose lease has not expired count against either quota. A rejected
 * reservation writes nothing and does not wait for a slot.
 *
 * The connection and the upstream model are not known at this point: they stay
 * NULL (the explicit "not yet known" representation, never a fabricated
 * identifier) until `assignAiInvocationIdentity` records the resolved,
 * authorized model. A reservation that never reaches that step is released by
 * `releaseAiInvocationReservation`; one whose write landed late is released by
 * its lease.
 */
export async function reserveAiInvocation(
  database: D1Database,
  input: {
    requestId: string
    apiKeyId: string
    startedAt: number
    deadlineAt: number
  },
): Promise<ReserveAiInvocationResult> {
  if (!isAiServerIdentifier(input.requestId)) {
    throw new RangeError("The AI invocation request id is invalid.")
  }
  if (
    input.apiKeyId.length < 1 ||
    input.apiKeyId.length > AI_INVOCATION_API_KEY_ID_MAX_LENGTH
  ) {
    throw new RangeError("The AI invocation api key id is invalid.")
  }
  requireEpochMilliseconds(input.startedAt, "The AI invocation start time")
  requireEpochMilliseconds(input.deadlineAt, "The AI invocation deadline")
  if (input.deadlineAt <= input.startedAt) {
    throw new RangeError("The AI invocation deadline must follow its start.")
  }
  const leaseExpiresAt = createAiInvocationLeaseExpiry(input.deadlineAt)

  const result = await database
    .prepare(
      `INSERT INTO "ai_invocations" (
         "requestId", "apiKeyId", "connectionId", "upstreamModelId",
         "startedAt", "deadlineAt", "leaseExpiresAt", "status"
       )
       SELECT ?1, ?2, NULL, NULL, ?3, ?4, ?5, 'reserved'
       WHERE (
         SELECT COUNT(*) FROM "ai_invocations"
         WHERE "status" = 'reserved' AND "leaseExpiresAt" > ?3
       ) < ?6
         AND (
           SELECT COUNT(*) FROM "ai_invocations"
           WHERE "status" = 'reserved' AND "apiKeyId" = ?2 AND "leaseExpiresAt" > ?3
         ) < ?7`,
    )
    .bind(
      input.requestId,
      input.apiKeyId,
      input.startedAt,
      input.deadlineAt,
      leaseExpiresAt,
      AI_MAX_IN_FLIGHT_INVOCATIONS,
      AI_MAX_IN_FLIGHT_INVOCATIONS_PER_KEY,
    )
    .run()

  if (readChanges(result, "reservation") === 1) {
    return { reserved: true }
  }

  const quota = await database
    .prepare(
      `SELECT COUNT(*) AS "keyInFlight" FROM "ai_invocations"
       WHERE "status" = 'reserved' AND "apiKeyId" = ?1 AND "leaseExpiresAt" > ?2`,
    )
    .bind(input.apiKeyId, input.startedAt)
    .first<{ keyInFlight: number }>()
  if (quota === null) {
    throw new TypeError("The AI invocation quota read is invalid.")
  }
  // The per-key limit is the more specific cause: a key at its own limit is
  // blocked regardless of the service-wide count. When the key still has
  // room, the single conditional write can only have failed on the
  // service-wide limit.
  if (quota.keyInFlight >= AI_MAX_IN_FLIGHT_INVOCATIONS_PER_KEY) {
    return { reserved: false, reason: "key-quota-exceeded" }
  }
  return { reserved: false, reason: "service-quota-exceeded" }
}

/**
 * Records the resolved and authorized model on a reservation. The write is
 * conditional on the reservation still being unidentified and un-terminated,
 * so a late identity can never rewrite a terminal row or overwrite an identity
 * another writer already recorded.
 */
export async function assignAiInvocationIdentity(
  database: D1Database,
  input: { requestId: string; connectionId: string; upstreamModelId: string },
): Promise<AssignAiInvocationIdentityResult> {
  if (!isAiServerIdentifier(input.requestId)) {
    throw new RangeError("The AI invocation request id is invalid.")
  }
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI invocation connection id is invalid.")
  }
  if (
    input.upstreamModelId.length < 1 ||
    input.upstreamModelId.length > AI_INVOCATION_UPSTREAM_MODEL_ID_MAX_LENGTH
  ) {
    throw new RangeError("The AI invocation upstream model id is invalid.")
  }

  const result = await database
    .prepare(
      `UPDATE "ai_invocations"
       SET "connectionId" = ?2, "upstreamModelId" = ?3
       WHERE "requestId" = ?1
         AND "status" = 'reserved'
         AND "connectionId" IS NULL
         AND "upstreamModelId" IS NULL`,
    )
    .bind(input.requestId, input.connectionId, input.upstreamModelId)
    .run()
  if (readChanges(result, "identity assignment") === 1) {
    return { assigned: true }
  }
  return {
    assigned: false,
    reason: await classifyReservationLoss(database, input.requestId),
  }
}

/**
 * Releases a reservation whose request never started: the slot is given back
 * immediately instead of waiting for the lease. Conditional on the row still
 * being unidentified and un-terminated, so it can never delete a call that
 * already ran (or is running).
 */
export async function releaseAiInvocationReservation(
  database: D1Database,
  requestId: string,
): Promise<ReleaseAiInvocationReservationResult> {
  if (!isAiServerIdentifier(requestId)) {
    throw new RangeError("The AI invocation request id is invalid.")
  }
  const result = await database
    .prepare(
      `DELETE FROM "ai_invocations"
       WHERE "requestId" = ?1
         AND "status" = 'reserved'
         AND "connectionId" IS NULL
         AND "upstreamModelId" IS NULL`,
    )
    .bind(requestId)
    .run()
  if (readChanges(result, "reservation release") === 1) {
    return { released: true }
  }
  return {
    released: false,
    reason: await classifyReservationLoss(database, requestId),
  }
}

async function classifyReservationLoss(
  database: D1Database,
  requestId: string,
): Promise<
  | "invocation-not-found"
  | "invocation-not-reserved"
  | "invocation-already-identified"
> {
  const row = await database
    .prepare(
      'SELECT "status", "connectionId", "upstreamModelId" FROM "ai_invocations" WHERE "requestId" = ?1',
    )
    .bind(requestId)
    .first<{
      connectionId: string | null
      status: AiInvocationStatus
      upstreamModelId: string | null
    }>()
  if (row === null) return "invocation-not-found"
  if (row.status !== "reserved") return "invocation-not-reserved"
  return "invocation-already-identified"
}

/**
 * Writes the terminal outcome exactly once. The conditional write rejects a
 * second terminal write or a late duplicate instead of replaying it, and the
 * failure is returned to the caller explicitly.
 */
export async function commitAiInvocationOutcome(
  database: D1Database,
  input: {
    requestId: string
    status: AiTerminalInvocationStatus
    endedAt: number
    errorCode?: string | null
    upstreamRequestId?: string | null
    usage?: string | null
  },
): Promise<CommitAiInvocationOutcomeResult> {
  if (!isAiServerIdentifier(input.requestId)) {
    throw new RangeError("The AI invocation request id is invalid.")
  }
  if (!isAiTerminalInvocationStatus(input.status)) {
    throw new RangeError("The AI invocation outcome status is not terminal.")
  }
  requireEpochMilliseconds(input.endedAt, "The AI invocation end time")
  const errorCode = input.errorCode ?? null
  const upstreamRequestId = input.upstreamRequestId ?? null
  const usage = input.usage ?? null
  if (
    errorCode !== null &&
    errorCode.length > AI_INVOCATION_ERROR_CODE_MAX_LENGTH
  ) {
    throw new RangeError("The AI invocation error code is invalid.")
  }
  if (
    upstreamRequestId !== null &&
    upstreamRequestId.length > AI_INVOCATION_UPSTREAM_REQUEST_ID_MAX_LENGTH
  ) {
    throw new RangeError("The AI invocation upstream request id is invalid.")
  }
  if (usage !== null && usage.length > AI_INVOCATION_USAGE_MAX_LENGTH) {
    throw new RangeError("The AI invocation usage payload is invalid.")
  }

  const result = await database
    .prepare(
      `UPDATE "ai_invocations"
       SET "status" = ?2, "endedAt" = ?3, "errorCode" = ?4,
           "upstreamRequestId" = ?5, "usage" = ?6
       WHERE "requestId" = ?1 AND "status" = 'reserved'`,
    )
    .bind(
      input.requestId,
      input.status,
      input.endedAt,
      errorCode,
      upstreamRequestId,
      usage,
    )
    .run()

  if (readChanges(result, "outcome commit") === 1) {
    return { committed: true }
  }

  const row = await database
    .prepare('SELECT "status" FROM "ai_invocations" WHERE "requestId" = ?1')
    .bind(input.requestId)
    .first<{ status: AiInvocationStatus }>()
  if (row === null) return { committed: false, reason: "invocation-not-found" }
  return { committed: false, reason: "invocation-already-terminal" }
}

/**
 * Reads invocation history newest-first with an exclusive
 * (startedAt DESC, requestId DESC) cursor. Rows are always filtered to the
 * shared 30-day retention boundary, so physical cleanup backlog never changes
 * what the read observes.
 */
export async function listAiInvocationHistory(
  database: D1Database,
  input: {
    now: number
    limit?: number
    before?: AiInvocationHistoryCursor
  },
): Promise<AiInvocationHistoryPage> {
  requireEpochMilliseconds(input.now, "The AI invocation history read time")
  const limit =
    input.limit === undefined
      ? AI_INVOCATION_HISTORY_DEFAULT_LIMIT
      : input.limit
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > AI_INVOCATION_HISTORY_MAX_LIMIT
  ) {
    throw new RangeError("The AI invocation history limit is invalid.")
  }
  const retentionCutoff = createAiInvocationRetentionCutoff(input.now)

  let cursorCondition = ""
  const bindings: (number | string)[] = []
  if (input.before !== undefined) {
    if (
      !Number.isSafeInteger(input.before.startedAt) ||
      !isAiServerIdentifier(input.before.requestId)
    ) {
      throw new RangeError("The AI invocation history cursor is invalid.")
    }
    bindings.push(input.before.startedAt, input.before.requestId)
    cursorCondition = `AND ("startedAt" < ?${bindings.length - 1} OR ("startedAt" = ?${bindings.length - 1} AND "requestId" < ?${bindings.length}))`
  }
  bindings.push(retentionCutoff, limit + 1)

  const rows = await database
    .prepare(
      `SELECT * FROM "ai_invocations"
       WHERE "startedAt" >= ?${bindings.length - 1} ${cursorCondition}
       ORDER BY "startedAt" DESC, "requestId" DESC
       LIMIT ?${bindings.length}`,
    )
    .bind(...bindings)
    .all<AiInvocationRow>()

  const hasMore = rows.results.length > limit
  const records = rows.results
    .slice(0, limit)
    .map((row) => toAiInvocationRecord(row, input.now))
  const last = records.at(-1)
  return {
    records,
    nextCursor:
      hasMore && last !== undefined
        ? { startedAt: last.startedAt, requestId: last.requestId }
        : null,
  }
}

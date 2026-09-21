import {
  AI_INVOCATIONS_TABLE,
  AI_AUTHORIZATION_SESSIONS_TABLE,
  createAiInvocationRetentionCutoff,
} from "./policy"

/**
 * Daily bounded AI cleanup, joined to the existing 0 20 * * * schedule.
 *
 * Expired device authorization sessions (including their encrypted device
 * grant payloads) and invocation metadata past the shared 30-day retention
 * boundary are deleted in batches of at most 500 rows with at most 10 batches
 * per category per run. Everything is a conditional DELETE keyed on the
 * scheduled boundary, so repeated or replayed crons are safe. Reservations
 * whose lease expired simply stop counting against the in-flight quota; they
 * are never deleted early, which would cut into the 30-day history retention.
 */

export interface AiCleanupResult {
  deletedAuthorizationSessions: number
  deletedInvocations: number
}

const AI_CLEANUP_BATCH_ROW_LIMIT = 500
const AI_CLEANUP_MAX_BATCHES_PER_CATEGORY = 10

export async function cleanupExpiredAiState(
  database: D1Database,
  scheduledTime: number,
): Promise<AiCleanupResult> {
  if (
    !Number.isSafeInteger(scheduledTime) ||
    !Number.isFinite(new Date(scheduledTime).getTime())
  ) {
    throw new Error("Invalid cleanup boundary")
  }
  // Both categories read the same scheduled boundary, so a single run never
  // drifts between the session expiry and the retention cutoff.
  const invocationCutoff = createAiInvocationRetentionCutoff(scheduledTime)

  const deletedAuthorizationSessions = await deleteExpiredRows(
    database,
    AI_AUTHORIZATION_SESSIONS_TABLE,
    "id",
    '"expiresAt"',
    scheduledTime,
  )
  const deletedInvocations = await deleteExpiredRows(
    database,
    AI_INVOCATIONS_TABLE,
    "requestId",
    '"startedAt"',
    invocationCutoff,
  )

  return { deletedAuthorizationSessions, deletedInvocations }
}

async function deleteExpiredRows(
  database: D1Database,
  table: string,
  primaryKeyColumn: string,
  boundaryColumn: string,
  boundary: number,
): Promise<number> {
  let deleted = 0
  for (let batch = 0; batch < AI_CLEANUP_MAX_BATCHES_PER_CATEGORY; batch++) {
    const result = await database
      .prepare(
        `DELETE FROM "${table}" WHERE "${primaryKeyColumn}" IN (
           SELECT "${primaryKeyColumn}" FROM "${table}"
           WHERE ${boundaryColumn} < ?1
           LIMIT ${AI_CLEANUP_BATCH_ROW_LIMIT}
         )`,
      )
      .bind(boundary)
      .run()

    const changes = result.meta.changes
    if (
      typeof changes !== "number" ||
      !Number.isSafeInteger(changes) ||
      changes < 0
    ) {
      throw new TypeError(`The AI ${table} cleanup result is invalid.`)
    }
    deleted += changes
    if (changes < AI_CLEANUP_BATCH_ROW_LIMIT) return deleted
    if (batch === AI_CLEANUP_MAX_BATCHES_PER_CATEGORY - 1) {
      // Desensitized backlog notice: the remaining rows wait for the next
      // scheduled run instead of raising the cron frequency.
      console.warn(JSON.stringify({ event: "cleanup_backlog", table }))
    }
  }
  return deleted
}

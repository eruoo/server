import { isAiServerIdentifier } from "../../shared/ai"

/**
 * Durable model catalog snapshots.
 *
 * A snapshot commit replaces the whole catalog for one connection in a single
 * atomic batch. Every statement re-checks the same connection predicate
 * (connected, credential version unchanged), which is stable inside the
 * transaction: when the guard fails, nothing is deleted or inserted, so a
 * failed or stale discovery result cannot overwrite the current snapshot.
 *
 * Upstream model IDs are stored exactly as reported — no case folding,
 * trimming, or URL decoding — and a snapshot row alone never implies the
 * connection is authorized or the model usable.
 */

export interface AiModelSnapshotEntry {
  upstreamModelId: string
  displayName: string | null
  capabilities: string | null
}

export interface AiModelRecord extends AiModelSnapshotEntry {
  connectionId: string
  snapshotCredentialVersion: number
  discoveredAt: number
}

export type CommitAiModelSnapshotResult =
  | { committed: true; modelCount: number }
  | {
      committed: false
      reason:
        | "connection-not-found"
        | "connection-not-connected"
        | "credential-version-changed"
    }

const AI_UPSTREAM_MODEL_ID_MAX_LENGTH = 200
const AI_MODEL_DISPLAY_NAME_MAX_LENGTH = 200
const AI_MODEL_CAPABILITIES_MAX_LENGTH = 4096
const AI_MODEL_SNAPSHOT_MAX_ENTRIES = 200

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
    throw new TypeError(`The AI model snapshot ${operation} result is invalid.`)
  }
  return changes
}

function validateSnapshotEntries(
  models: readonly AiModelSnapshotEntry[],
): void {
  if (models.length > AI_MODEL_SNAPSHOT_MAX_ENTRIES) {
    throw new RangeError("The AI model snapshot exceeds its entry limit.")
  }
  const seen = new Set<string>()
  for (const model of models) {
    if (
      model.upstreamModelId.length < 1 ||
      model.upstreamModelId.length > AI_UPSTREAM_MODEL_ID_MAX_LENGTH
    ) {
      throw new RangeError("The AI upstream model id is invalid.")
    }
    if (seen.has(model.upstreamModelId)) {
      throw new RangeError(
        "The AI model snapshot contains a duplicate model id.",
      )
    }
    seen.add(model.upstreamModelId)
    if (
      model.displayName !== null &&
      model.displayName.length > AI_MODEL_DISPLAY_NAME_MAX_LENGTH
    ) {
      throw new RangeError("The AI model display name is invalid.")
    }
    if (
      model.capabilities !== null &&
      model.capabilities.length > AI_MODEL_CAPABILITIES_MAX_LENGTH
    ) {
      throw new RangeError("The AI model capabilities payload is invalid.")
    }
  }
}

export async function listAiModels(
  database: D1Database,
  connectionId: string,
): Promise<AiModelRecord[]> {
  if (!isAiServerIdentifier(connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  const rows = await database
    .prepare(
      `SELECT "connectionId", "upstreamModelId", "displayName", "capabilities",
              "snapshotCredentialVersion", "discoveredAt"
       FROM "ai_models"
       WHERE "connectionId" = ?1
       ORDER BY "upstreamModelId"`,
    )
    .bind(connectionId)
    .all<AiModelRecord>()
  return rows.results
}

export async function commitAiModelSnapshot(
  database: D1Database,
  input: {
    connectionId: string
    observedCredentialVersion: number
    models: readonly AiModelSnapshotEntry[]
    now: number
  },
): Promise<CommitAiModelSnapshotResult> {
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (
    !Number.isSafeInteger(input.observedCredentialVersion) ||
    input.observedCredentialVersion < 0
  ) {
    throw new RangeError("The AI credential version is invalid.")
  }
  validateSnapshotEntries(input.models)
  requireEpochMilliseconds(input.now, "The AI model snapshot commit time")

  // Every statement carries the same live predicate. The first statement both
  // marks the catalog refresh and reports whether the guard held; without it
  // the delete and inserts match no rows, preserving the previous snapshot.
  const connectionGuard = `SELECT 1 FROM "ai_connections"
       WHERE "id" = ?1
         AND "authorizationStatus" = 'connected'
         AND "credentialVersion" = ?2`

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE "ai_connections"
         SET "updatedAt" = ?3
         WHERE "id" = ?1
           AND "authorizationStatus" = 'connected'
           AND "credentialVersion" = ?2`,
      )
      .bind(input.connectionId, input.observedCredentialVersion, input.now),
    database
      .prepare(
        `DELETE FROM "ai_models"
         WHERE "connectionId" = ?1 AND EXISTS (${connectionGuard})`,
      )
      .bind(input.connectionId, input.observedCredentialVersion),
  ]
  for (const model of input.models) {
    statements.push(
      database
        .prepare(
          `INSERT INTO "ai_models" (
             "connectionId", "upstreamModelId", "displayName", "capabilities",
             "snapshotCredentialVersion", "discoveredAt"
           )
           SELECT ?1, ?3, ?4, ?5, ?2, ?6
           WHERE EXISTS (${connectionGuard})`,
        )
        .bind(
          input.connectionId,
          input.observedCredentialVersion,
          model.upstreamModelId,
          model.displayName,
          model.capabilities,
          input.now,
        ),
    )
  }

  const results = await database.batch<unknown>(statements)
  if (results.length !== statements.length) {
    throw new TypeError("The AI model snapshot commit result is invalid.")
  }

  const guardChanges = readChanges(results[0], "commit guard")
  if (guardChanges === 0) {
    return {
      committed: false,
      reason: await classifySnapshotRejection(database, input),
    }
  }
  for (let index = 2; index < results.length; index++) {
    if (readChanges(results[index], "commit insert") !== 1) {
      throw new Error(
        "The AI model snapshot commit violated its atomic commit invariant.",
      )
    }
  }

  return { committed: true, modelCount: input.models.length }
}

async function classifySnapshotRejection(
  database: D1Database,
  input: { connectionId: string; observedCredentialVersion: number },
): Promise<
  | "connection-not-found"
  | "connection-not-connected"
  | "credential-version-changed"
> {
  const connection = await database
    .prepare(
      'SELECT "authorizationStatus", "credentialVersion" FROM "ai_connections" WHERE "id" = ?1',
    )
    .bind(input.connectionId)
    .first<{
      authorizationStatus:
        | "never_authorized"
        | "connected"
        | "reauthentication_required"
      credentialVersion: number
    }>()
  if (connection === null) return "connection-not-found"
  if (connection.authorizationStatus !== "connected") {
    return "connection-not-connected"
  }
  if (connection.credentialVersion !== input.observedCredentialVersion) {
    return "credential-version-changed"
  }
  throw new Error(
    "The AI model snapshot commit failed while its guard conditions held.",
  )
}

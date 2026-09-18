import {
  isAiConnectionSlug,
  isAiProviderType,
  isAiServerIdentifier,
  type AiConnectionAuthorizationStatus,
} from "../../shared/ai"

/**
 * Durable AI connection lifecycle operations.
 *
 * Every mutation is a conditional D1 write: D1 is the only source of truth for
 * cross-request state, so callers racing from independent Worker instances are
 * coordinated by the row conditions themselves, never by module-level promises
 * or locks. The backup-only `maintenance_lease` table is intentionally unused.
 */

export interface AiConnectionRecord {
  id: string
  slug: string
  name: string
  providerType: string
  enabled: boolean
  authorizationStatus: AiConnectionAuthorizationStatus
  upstreamAccountId: string | null
  credentialVersion: number
  credentialCiphertext: string | null
  credentialExpiresAt: number | null
  refreshClaimId: string | null
  refreshClaimExpiresAt: number | null
  createdAt: number
  updatedAt: number
}

interface AiConnectionRow {
  id: string
  slug: string
  name: string
  providerType: string
  enabled: number
  authorizationStatus: AiConnectionAuthorizationStatus
  upstreamAccountId: string | null
  credentialVersion: number
  credentialCiphertext: string | null
  credentialExpiresAt: number | null
  refreshClaimId: string | null
  refreshClaimExpiresAt: number | null
  createdAt: number
  updatedAt: number
}

const AI_CONNECTION_NAME_MAX_LENGTH = 100

function requireEpochMilliseconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be safe epoch milliseconds.`)
  }
}

function toAiConnectionRecord(row: AiConnectionRow): AiConnectionRecord {
  return {
    ...row,
    enabled: row.enabled === 1,
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
    throw new TypeError(`The AI connection ${operation} result is invalid.`)
  }
  return changes
}

export async function getAiConnection(
  database: D1Database,
  id: string,
): Promise<AiConnectionRecord | null> {
  if (!isAiServerIdentifier(id)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  const row = await database
    .prepare('SELECT * FROM "ai_connections" WHERE "id" = ?1')
    .bind(id)
    .first<AiConnectionRow>()
  return row === null ? null : toAiConnectionRecord(row)
}

export async function listAiConnections(
  database: D1Database,
): Promise<AiConnectionRecord[]> {
  const rows = await database
    .prepare(
      'SELECT * FROM "ai_connections" ORDER BY "createdAt" DESC, "id" DESC',
    )
    .all<AiConnectionRow>()
  return rows.results.map(toAiConnectionRecord)
}

export type CreateAiConnectionResult =
  | { created: true; connection: AiConnectionRecord }
  | { created: false; reason: "slug-exists" }

export async function createAiConnection(
  database: D1Database,
  input: {
    id: string
    slug: string
    name: string
    providerType: string
    now: number
  },
): Promise<CreateAiConnectionResult> {
  if (!isAiServerIdentifier(input.id)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (!isAiConnectionSlug(input.slug)) {
    throw new RangeError("The AI connection slug is invalid.")
  }
  if (
    input.name.length < 1 ||
    input.name.length > AI_CONNECTION_NAME_MAX_LENGTH
  ) {
    throw new RangeError("The AI connection name is invalid.")
  }
  if (!isAiProviderType(input.providerType)) {
    throw new RangeError("The AI connection provider type is unknown.")
  }
  requireEpochMilliseconds(input.now, "The AI connection creation time")

  // A single conditional insert decides slug uniqueness without a prior read,
  // so two concurrent creations of the same slug produce exactly one row.
  const result = await database
    .prepare(
      `INSERT INTO "ai_connections" (
         "id", "slug", "name", "providerType", "enabled",
         "authorizationStatus", "upstreamAccountId", "credentialVersion",
         "credentialCiphertext", "credentialExpiresAt", "refreshClaimId",
         "refreshClaimExpiresAt", "createdAt", "updatedAt"
       )
       SELECT ?1, ?2, ?3, ?4, 1,
         'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, ?5, ?5
       WHERE NOT EXISTS (SELECT 1 FROM "ai_connections" WHERE "slug" = ?2)`,
    )
    .bind(input.id, input.slug, input.name, input.providerType, input.now)
    .run()

  if (readChanges(result, "creation") === 0) {
    return { created: false, reason: "slug-exists" }
  }
  return {
    created: true,
    connection: {
      id: input.id,
      slug: input.slug,
      name: input.name,
      providerType: input.providerType,
      enabled: true,
      authorizationStatus: "never_authorized",
      upstreamAccountId: null,
      credentialVersion: 0,
      credentialCiphertext: null,
      credentialExpiresAt: null,
      refreshClaimId: null,
      refreshClaimExpiresAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  }
}

export type UpdateAiConnectionResult =
  | { updated: true }
  | { updated: false; reason: "not-found" }

export async function updateAiConnection(
  database: D1Database,
  input: {
    id: string
    name?: string
    enabled?: boolean
    now: number
  },
): Promise<UpdateAiConnectionResult> {
  if (!isAiServerIdentifier(input.id)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (input.name !== undefined) {
    if (
      input.name.length < 1 ||
      input.name.length > AI_CONNECTION_NAME_MAX_LENGTH
    ) {
      throw new RangeError("The AI connection name is invalid.")
    }
  }
  requireEpochMilliseconds(input.now, "The AI connection update time")
  if (input.name === undefined && input.enabled === undefined) {
    throw new RangeError("The AI connection update is empty.")
  }

  const assignments: string[] = ['"updatedAt" = ?2']
  const values: (string | number)[] = [input.id, input.now]
  if (input.name !== undefined) {
    values.push(input.name)
    assignments.push(`"name" = ?${values.length}`)
  }
  if (input.enabled !== undefined) {
    values.push(input.enabled ? 1 : 0)
    assignments.push(`"enabled" = ?${values.length}`)
  }

  const result = await database
    .prepare(
      `UPDATE "ai_connections" SET ${assignments.join(", ")}
       WHERE "id" = ?1`,
    )
    .bind(...values)
    .run()

  return readChanges(result, "update") === 1
    ? { updated: true }
    : { updated: false, reason: "not-found" }
}

export type DisconnectAiConnectionResult =
  | { disconnected: true; clearedCredentials: boolean }
  | { disconnected: false; reason: "not-found" }

/**
 * Disconnecting clears credentials, drops any refresh claim, advances the
 * credential version, and cancels pending authorization sessions in one atomic
 * batch. Because the version advances and the claim is removed, a late refresh
 * or exchange result can no longer overwrite the disconnected state.
 */
export async function disconnectAiConnection(
  database: D1Database,
  input: { id: string; now: number },
): Promise<DisconnectAiConnectionResult> {
  const existing = await getAiConnection(database, input.id)
  if (existing === null) {
    return { disconnected: false, reason: "not-found" }
  }
  requireEpochMilliseconds(input.now, "The AI connection disconnect time")

  const results = await database.batch<unknown>([
    database
      .prepare(
        `UPDATE "ai_connections"
         SET "authorizationStatus" = 'reauthentication_required',
             "credentialCiphertext" = NULL,
             "credentialExpiresAt" = NULL,
             "refreshClaimId" = NULL,
             "refreshClaimExpiresAt" = NULL,
             "credentialVersion" = "credentialVersion" + 1,
             "updatedAt" = ?2
         WHERE "id" = ?1
           AND ("credentialCiphertext" IS NOT NULL OR "refreshClaimId" IS NOT NULL)`,
      )
      .bind(input.id, input.now),
    database
      .prepare(
        `UPDATE "ai_authorization_sessions"
         SET "status" = 'cancelled', "updatedAt" = ?2
         WHERE "connectionId" = ?1 AND "status" = 'pending'`,
      )
      .bind(input.id, input.now),
  ])
  if (results.length !== 2) {
    throw new TypeError("The AI connection disconnect result is invalid.")
  }

  return {
    disconnected: true,
    clearedCredentials: readChanges(results[0], "disconnect") === 1,
  }
}

export type DeleteAiConnectionResult =
  | { deleted: true }
  | { deleted: false; reason: "not-found" }

/**
 * Deleting removes the connection, its pending authorization sessions, and its
 * model snapshots. Invocation history keeps its identifier snapshots because
 * ai_invocations deliberately has no foreign key to connections.
 */
export async function deleteAiConnection(
  database: D1Database,
  input: { id: string },
): Promise<DeleteAiConnectionResult> {
  if (!isAiServerIdentifier(input.id)) {
    throw new RangeError("The AI connection id is invalid.")
  }

  const results = await database.batch<unknown>([
    database
      .prepare(
        'DELETE FROM "ai_authorization_sessions" WHERE "connectionId" = ?1',
      )
      .bind(input.id),
    database
      .prepare('DELETE FROM "ai_models" WHERE "connectionId" = ?1')
      .bind(input.id),
    database
      .prepare('DELETE FROM "ai_connections" WHERE "id" = ?1')
      .bind(input.id),
  ])
  if (results.length !== 3) {
    throw new TypeError("The AI connection deletion result is invalid.")
  }

  return readChanges(results[2], "deletion") === 1
    ? { deleted: true }
    : { deleted: false, reason: "not-found" }
}

import {
  AI_AUTHORIZATION_POLL_CLAIM_TTL_MS,
  AI_AUTHORIZATION_POLL_MIN_INTERVAL_MS,
  AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
  isAiServerIdentifier,
  type AiAuthorizationSessionStatus,
} from "../../shared/ai"

/**
 * Durable device-authorization session operations.
 *
 * A session is bound to the owner, the creating session, and the connection's
 * credential version. The poll claim is a conditional single-row write, so
 * concurrent tabs from independent instances produce exactly one winner. The
 * completion batch updates the session and the connection credentials
 * all-or-nothing: both statements carry guards that can only succeed or fail
 * together, and the batch result is asserted to prove it.
 */

export interface AiAuthorizationSessionRecord {
  id: string
  connectionId: string
  ownerUserId: string
  ownerSessionId: string
  connectionCredentialVersion: number
  status: AiAuthorizationSessionStatus
  deviceGrantCiphertext: string
  expiresAt: number
  nextPollAt: number
  pollClaimId: string | null
  pollClaimExpiresAt: number | null
  completionId: string | null
  createdAt: number
  updatedAt: number
}

export type CreateAiAuthorizationSessionResult =
  | { created: true; session: AiAuthorizationSessionRecord }
  | { created: false; reason: "connection-not-found" }

export type AiAuthorizationPollRejectionReason =
  | "session-not-found"
  | "owner-session-mismatch"
  | "session-not-pending"
  | "session-expired"
  | "poll-too-early"
  | "poll-claim-held"
  | "connection-missing"
  | "connection-version-changed"

export type ClaimAiAuthorizationPollResult =
  | { claimed: true; session: AiAuthorizationSessionRecord }
  | { claimed: false; reason: AiAuthorizationPollRejectionReason }

export type AiAuthorizationCompletionRejectionReason =
  | "session-not-found"
  | "session-not-pending"
  | "claim-not-held"
  | "session-expired"
  | "owner-session-revoked"
  | "connection-missing"
  | "connection-version-changed"
  | "upstream-account-mismatch"

export type CompleteAiAuthorizationResult =
  | { completed: true }
  | { completed: false; reason: AiAuthorizationCompletionRejectionReason }

const AI_DEVICE_GRANT_CIPHERTEXT_MAX_LENGTH = 4096

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
    throw new TypeError(
      `The AI authorization session ${operation} result is invalid.`,
    )
  }
  return changes
}

async function readSession(
  database: D1Database,
  id: string,
): Promise<AiAuthorizationSessionRecord | null> {
  return database
    .prepare('SELECT * FROM "ai_authorization_sessions" WHERE "id" = ?1')
    .bind(id)
    .first<AiAuthorizationSessionRecord>()
}

async function readConnectionState(
  database: D1Database,
  connectionId: string,
): Promise<{
  credentialVersion: number
  upstreamAccountId: string | null
} | null> {
  return database
    .prepare(
      'SELECT "credentialVersion", "upstreamAccountId" FROM "ai_connections" WHERE "id" = ?1',
    )
    .bind(connectionId)
    .first<{ credentialVersion: number; upstreamAccountId: string | null }>()
}

export async function getAiAuthorizationSession(
  database: D1Database,
  id: string,
): Promise<AiAuthorizationSessionRecord | null> {
  if (!isAiServerIdentifier(id)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  return readSession(database, id)
}

export async function createAiAuthorizationSession(
  database: D1Database,
  input: {
    id: string
    connectionId: string
    ownerUserId: string
    ownerSessionId: string
    deviceGrantCiphertext: string
    sessionTtlMs: number
    pollIntervalMs: number
    now: number
  },
): Promise<CreateAiAuthorizationSessionResult> {
  if (!isAiServerIdentifier(input.id)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  if (!isAiServerIdentifier(input.connectionId)) {
    throw new RangeError("The AI connection id is invalid.")
  }
  if (input.ownerUserId.length < 1 || input.ownerUserId.length > 64) {
    throw new RangeError("The AI authorization owner id is invalid.")
  }
  if (input.ownerSessionId.length < 1 || input.ownerSessionId.length > 64) {
    throw new RangeError("The AI authorization owner session id is invalid.")
  }
  if (
    input.deviceGrantCiphertext.length < 1 ||
    input.deviceGrantCiphertext.length > AI_DEVICE_GRANT_CIPHERTEXT_MAX_LENGTH
  ) {
    throw new RangeError("The AI device grant ciphertext is invalid.")
  }
  if (
    !Number.isSafeInteger(input.sessionTtlMs) ||
    input.sessionTtlMs <= 0 ||
    input.sessionTtlMs > AI_AUTHORIZATION_SESSION_MAX_TTL_MS
  ) {
    throw new RangeError("The AI authorization session ttl is invalid.")
  }
  if (
    !Number.isSafeInteger(input.pollIntervalMs) ||
    input.pollIntervalMs < AI_AUTHORIZATION_POLL_MIN_INTERVAL_MS
  ) {
    throw new RangeError("The AI authorization poll interval is invalid.")
  }
  requireEpochMilliseconds(
    input.now,
    "The AI authorization session creation time",
  )

  const expiresAt = input.now + input.sessionTtlMs
  const nextPollAt = input.now + input.pollIntervalMs
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nextPollAt)) {
    throw new RangeError("The AI authorization session timing is invalid.")
  }

  // The insert binds the session to the connection's current credential
  // version atomically and returns the inserted row from the same statement:
  // if the connection vanished nothing is inserted, and the returned record
  // always reflects this operation's own write.
  const result = await database
    .prepare(
      `INSERT INTO "ai_authorization_sessions" (
         "id", "connectionId", "ownerUserId", "ownerSessionId",
         "connectionCredentialVersion", "status", "deviceGrantCiphertext",
         "expiresAt", "nextPollAt", "pollClaimId", "pollClaimExpiresAt",
         "completionId", "createdAt", "updatedAt"
       )
       SELECT ?1, ?2, ?3, ?4, "credentialVersion", 'pending', ?5, ?6, ?7,
         NULL, NULL, NULL, ?8, ?8
       FROM "ai_connections" WHERE "id" = ?2
       RETURNING "id", "connectionId", "ownerUserId", "ownerSessionId",
         "connectionCredentialVersion", "status", "deviceGrantCiphertext",
         "expiresAt", "nextPollAt", "pollClaimId", "pollClaimExpiresAt",
         "completionId", "createdAt", "updatedAt"`,
    )
    .bind(
      input.id,
      input.connectionId,
      input.ownerUserId,
      input.ownerSessionId,
      input.deviceGrantCiphertext,
      expiresAt,
      nextPollAt,
      input.now,
    )
    .all<AiAuthorizationSessionRecord>()

  const changes = readChanges(result, "creation")
  if (result.results.length === 1 && changes === 1) {
    return { created: true, session: result.results[0] }
  }
  if (result.results.length === 0 && changes === 0) {
    return { created: false, reason: "connection-not-found" }
  }
  throw new TypeError(
    "The AI authorization session creation result is invalid.",
  )
}

export async function claimAiAuthorizationPoll(
  database: D1Database,
  input: {
    sessionId: string
    ownerUserId: string
    ownerSessionId: string
    claimId: string
    now: number
  },
): Promise<ClaimAiAuthorizationPollResult> {
  if (!isAiServerIdentifier(input.sessionId)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI authorization poll claim id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI authorization poll time")

  const claimExpiresAt = input.now + AI_AUTHORIZATION_POLL_CLAIM_TTL_MS
  if (!Number.isSafeInteger(claimExpiresAt)) {
    throw new RangeError("The AI authorization poll claim expiry is invalid.")
  }

  // RETURNING yields the row exactly as this claim wrote it, so the returned
  // session is this operation's own atomic snapshot: a concurrent cancel or
  // version change cannot substitute another state into the result.
  const result = await database
    .prepare(
      `UPDATE "ai_authorization_sessions"
       SET "pollClaimId" = ?3, "pollClaimExpiresAt" = ?4, "updatedAt" = ?2
       WHERE "id" = ?1
         AND "status" = 'pending'
         AND "ownerUserId" = ?5
         AND "ownerSessionId" = ?6
         AND "nextPollAt" <= ?2
         AND "expiresAt" > ?2
         AND ("pollClaimId" IS NULL OR "pollClaimExpiresAt" <= ?2)
         AND "connectionCredentialVersion" = (
           SELECT "credentialVersion" FROM "ai_connections"
           WHERE "id" = "ai_authorization_sessions"."connectionId"
         )
       RETURNING "id", "connectionId", "ownerUserId", "ownerSessionId",
         "connectionCredentialVersion", "status", "deviceGrantCiphertext",
         "expiresAt", "nextPollAt", "pollClaimId", "pollClaimExpiresAt",
         "completionId", "createdAt", "updatedAt"`,
    )
    .bind(
      input.sessionId,
      input.now,
      input.claimId,
      claimExpiresAt,
      input.ownerUserId,
      input.ownerSessionId,
    )
    .all<AiAuthorizationSessionRecord>()

  const changes = readChanges(result, "poll claim")
  if (result.results.length === 1 && changes === 1) {
    return { claimed: true, session: result.results[0] }
  }
  if (result.results.length === 0 && changes === 0) {
    return {
      claimed: false,
      reason: await classifyPollRejection(database, input),
    }
  }
  throw new TypeError("The AI authorization poll claim result is invalid.")
}

async function classifyPollRejection(
  database: D1Database,
  input: {
    sessionId: string
    ownerUserId: string
    ownerSessionId: string
    now: number
  },
): Promise<AiAuthorizationPollRejectionReason> {
  const session = await readSession(database, input.sessionId)
  if (session === null) return "session-not-found"
  if (
    session.ownerUserId !== input.ownerUserId ||
    session.ownerSessionId !== input.ownerSessionId
  ) {
    return "owner-session-mismatch"
  }
  if (session.status !== "pending") return "session-not-pending"
  if (session.expiresAt <= input.now) return "session-expired"
  if (session.nextPollAt > input.now) return "poll-too-early"
  const connection = await readConnectionState(database, session.connectionId)
  if (connection === null) return "connection-missing"
  if (connection.credentialVersion !== session.connectionCredentialVersion) {
    return "connection-version-changed"
  }
  // The remaining failure cause is claim contention at write time.
  return "poll-claim-held"
}

export async function releaseAiAuthorizationPoll(
  database: D1Database,
  input: {
    sessionId: string
    claimId: string
    nextPollAt: number
    now: number
  },
): Promise<{ released: boolean }> {
  if (!isAiServerIdentifier(input.sessionId)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI authorization poll claim id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI authorization poll release time")
  if (!Number.isSafeInteger(input.nextPollAt) || input.nextPollAt < input.now) {
    throw new RangeError("The AI authorization next poll time is invalid.")
  }

  const result = await database
    .prepare(
      `UPDATE "ai_authorization_sessions"
       SET "pollClaimId" = NULL, "pollClaimExpiresAt" = NULL,
           "nextPollAt" = ?3, "updatedAt" = ?4
       WHERE "id" = ?1 AND "status" = 'pending' AND "pollClaimId" = ?2`,
    )
    .bind(input.sessionId, input.claimId, input.nextPollAt, input.now)
    .run()

  return { released: readChanges(result, "poll release") === 1 }
}

export async function cancelAiAuthorizationSession(
  database: D1Database,
  input: {
    sessionId: string
    ownerUserId: string
    ownerSessionId: string
    now: number
  },
): Promise<{ cancelled: boolean }> {
  if (!isAiServerIdentifier(input.sessionId)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  requireEpochMilliseconds(input.now, "The AI authorization cancel time")

  const result = await database
    .prepare(
      `UPDATE "ai_authorization_sessions"
       SET "status" = 'cancelled', "updatedAt" = ?4
       WHERE "id" = ?1 AND "status" = 'pending'
         AND "ownerUserId" = ?2 AND "ownerSessionId" = ?3`,
    )
    .bind(input.sessionId, input.ownerUserId, input.ownerSessionId, input.now)
    .run()

  return { cancelled: readChanges(result, "cancel") === 1 }
}

/**
 * Completes a device authorization atomically with the connection credential
 * update.
 *
 * The connection to update is derived exclusively from the session's own
 * binding — there is no separate connection identity in the input, so a
 * completion can never write to another connection that happens to share the
 * bound version.
 *
 * Statement 1 marks the session completed only while the poll claim is valid,
 * the session is unexpired, the creating owner session still exists, the
 * bound connection still exists at the session's bound version, and the
 * upstream account is unchanged. It stamps a fresh completion id.
 * Statement 2 saves the credential package and advances that same
 * connection's version, gated on the fresh completion id and the bound
 * version from the session row.
 *
 * Both statements therefore succeed or fail together: without the fresh
 * completion id from statement 1, statement 2 matches no row, and when
 * statement 1 succeeds its guards guarantee statement 2's conditions. The
 * post-batch assertion turns any divergence into a loud invariant failure.
 */
export async function completeAiAuthorization(
  database: D1Database,
  input: {
    sessionId: string
    claimId: string
    completionId: string
    credentialCiphertext: string
    credentialExpiresAt: number
    upstreamAccountId: string
    now: number
  },
): Promise<CompleteAiAuthorizationResult> {
  if (!isAiServerIdentifier(input.sessionId)) {
    throw new RangeError("The AI authorization session id is invalid.")
  }
  if (!isAiServerIdentifier(input.claimId)) {
    throw new RangeError("The AI authorization poll claim id is invalid.")
  }
  if (!isAiServerIdentifier(input.completionId)) {
    throw new RangeError("The AI authorization completion id is invalid.")
  }
  if (
    input.credentialCiphertext.length < 1 ||
    input.credentialCiphertext.length > 4096
  ) {
    throw new RangeError("The AI credential ciphertext is invalid.")
  }
  if (
    input.upstreamAccountId.length < 1 ||
    input.upstreamAccountId.length > 128
  ) {
    throw new RangeError("The AI upstream account id is invalid.")
  }
  requireEpochMilliseconds(
    input.credentialExpiresAt,
    "The AI credential expiry",
  )
  requireEpochMilliseconds(input.now, "The AI authorization completion time")

  const results = await database.batch<unknown>([
    database
      .prepare(
        `UPDATE "ai_authorization_sessions"
         SET "status" = 'completed', "completionId" = ?1, "updatedAt" = ?2
         WHERE "id" = ?3
           AND "status" = 'pending'
           AND "pollClaimId" = ?4
           AND "pollClaimExpiresAt" > ?2
           AND "expiresAt" > ?2
           AND EXISTS (
             SELECT 1 FROM "ai_connections" AS "connection"
             WHERE "connection"."id" = "ai_authorization_sessions"."connectionId"
               AND "connection"."credentialVersion"
                 = "ai_authorization_sessions"."connectionCredentialVersion"
               AND (
                 "connection"."upstreamAccountId" IS NULL
                 OR "connection"."upstreamAccountId" = ?5
               )
           )
           AND EXISTS (
             SELECT 1 FROM "session"
             WHERE "id" = "ai_authorization_sessions"."ownerSessionId"
           )`,
      )
      .bind(
        input.completionId,
        input.now,
        input.sessionId,
        input.claimId,
        input.upstreamAccountId,
      ),
    database
      .prepare(
        `UPDATE "ai_connections"
         SET "authorizationStatus" = 'connected',
             "credentialCiphertext" = ?1,
             "credentialExpiresAt" = ?2,
             "upstreamAccountId" = ?3,
             "credentialVersion" = "credentialVersion" + 1,
             "refreshClaimId" = NULL,
             "refreshClaimExpiresAt" = NULL,
             "updatedAt" = ?4
         WHERE "id" = (
             SELECT "connectionId" FROM "ai_authorization_sessions"
             WHERE "id" = ?5 AND "status" = 'completed' AND "completionId" = ?6
           )
           AND "credentialVersion" = (
             SELECT "connectionCredentialVersion"
             FROM "ai_authorization_sessions"
             WHERE "id" = ?5 AND "status" = 'completed' AND "completionId" = ?6
           )`,
      )
      .bind(
        input.credentialCiphertext,
        input.credentialExpiresAt,
        input.upstreamAccountId,
        input.now,
        input.sessionId,
        input.completionId,
      ),
  ])
  if (results.length !== 2) {
    throw new TypeError("The AI authorization completion result is invalid.")
  }

  const sessionChanges = readChanges(results[0], "completion")
  const connectionChanges = readChanges(results[1], "completion")
  if (sessionChanges !== connectionChanges) {
    throw new Error(
      "The AI authorization completion violated its atomic commit invariant.",
    )
  }
  if (sessionChanges === 1) return { completed: true }

  return {
    completed: false,
    reason: await classifyCompletionRejection(database, input),
  }
}

async function classifyCompletionRejection(
  database: D1Database,
  input: {
    sessionId: string
    claimId: string
    upstreamAccountId: string
    now: number
  },
): Promise<AiAuthorizationCompletionRejectionReason> {
  const session = await readSession(database, input.sessionId)
  if (session === null) return "session-not-found"
  if (session.status !== "pending") return "session-not-pending"
  if (
    session.pollClaimId !== input.claimId ||
    session.pollClaimExpiresAt === null ||
    session.pollClaimExpiresAt <= input.now
  ) {
    return "claim-not-held"
  }
  if (session.expiresAt <= input.now) return "session-expired"
  const ownerSessionExists = await database
    .prepare('SELECT 1 FROM "session" WHERE "id" = ?1')
    .bind(session.ownerSessionId)
    .first<number>()
  if (ownerSessionExists === null) return "owner-session-revoked"
  const connection = await readConnectionState(database, session.connectionId)
  if (connection === null) return "connection-missing"
  if (connection.credentialVersion !== session.connectionCredentialVersion) {
    return "connection-version-changed"
  }
  if (
    connection.upstreamAccountId !== null &&
    connection.upstreamAccountId !== input.upstreamAccountId
  ) {
    return "upstream-account-mismatch"
  }
  return "claim-not-held"
}

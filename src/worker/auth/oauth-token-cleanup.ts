import { OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS } from "../../shared/oauth"

export interface OAuthTokenCleanupResult {
  clearedReplayResponses: number
  deletedAccessTokens: number
  deletedFamilyRevocations: number
  deletedRefreshTokens: number
}

const DAILY_OAUTH_TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

export const OAUTH_REFRESH_FAMILY_REVOCATION_RETENTION_MS =
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS * 1000 +
  DAILY_OAUTH_TOKEN_CLEANUP_INTERVAL_MS

export function createOAuthRefreshFamilyRevocationCutoff(
  nowMilliseconds: number,
): number {
  if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < 0) {
    throw new RangeError("The OAuth token cleanup boundary is invalid.")
  }

  const cutoffMilliseconds =
    nowMilliseconds - OAUTH_REFRESH_FAMILY_REVOCATION_RETENTION_MS
  if (!Number.isSafeInteger(cutoffMilliseconds)) {
    throw new RangeError("The OAuth family revocation cutoff is invalid.")
  }

  return cutoffMilliseconds
}

function createCleanupBoundary(nowMilliseconds: number): string {
  const boundary = new Date(nowMilliseconds)
  if (
    !Number.isSafeInteger(nowMilliseconds) ||
    nowMilliseconds < 0 ||
    !Number.isFinite(boundary.getTime())
  ) {
    throw new RangeError("The OAuth token cleanup boundary is invalid.")
  }

  return boundary.toISOString()
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
    throw new TypeError(`The OAuth token ${operation} result is invalid.`)
  }

  return changes
}

/**
 * Removes OAuth token state that is no longer live at the scheduled boundary.
 *
 * The ordered D1 batch keeps the encrypted refresh replay response only for its
 * retry window, removes expired access tokens before their parent refresh rows,
 * and retains family tombstones for the maximum successor lifetime plus one
 * cleanup interval, and longer while any unexpired family member still exists.
 */
export async function cleanupExpiredOAuthTokenState(
  database: D1Database,
  nowMilliseconds = Date.now(),
): Promise<OAuthTokenCleanupResult> {
  const boundary = createCleanupBoundary(nowMilliseconds)
  const familyRevocationCutoff =
    createOAuthRefreshFamilyRevocationCutoff(nowMilliseconds)
  const results = await database.batch<unknown>([
    database
      .prepare(
        `UPDATE oauthRefreshToken
         SET rotationReplayResponse = NULL
         WHERE rotationReplayResponse IS NOT NULL
           AND rotationReplayExpiresAt < ?1`,
      )
      .bind(boundary),
    database
      .prepare(
        `DELETE FROM oauthAccessToken
         WHERE expiresAt < ?1`,
      )
      .bind(boundary),
    database
      .prepare(
        `DELETE FROM oauthRefreshToken AS refresh
         WHERE refresh.expiresAt < ?1
           AND NOT EXISTS (
             SELECT 1
             FROM oauthAccessToken AS access
             WHERE access.refreshId = refresh.id
               AND access.expiresAt >= ?1
           )`,
      )
      .bind(boundary),
    database
      .prepare(
        `DELETE FROM oauthRefreshTokenFamilyRevocation AS revocation
         WHERE revocation.revokedAt < ?1
           AND NOT EXISTS (
           SELECT 1
           FROM oauthRefreshToken AS refresh
           WHERE refresh.authorizationCodeId = revocation.authorizationCodeId
             AND refresh.clientId = revocation.clientId
             AND refresh.userId = revocation.userId
             AND refresh.expiresAt >= ?2
         )`,
      )
      .bind(familyRevocationCutoff, boundary),
  ])

  if (results.length !== 4) {
    throw new TypeError("The OAuth token cleanup result is invalid.")
  }

  return {
    clearedReplayResponses: readChanges(results[0], "replay cleanup"),
    deletedAccessTokens: readChanges(results[1], "access cleanup"),
    deletedRefreshTokens: readChanges(results[2], "refresh cleanup"),
    deletedFamilyRevocations: readChanges(
      results[3],
      "family revocation cleanup",
    ),
  }
}

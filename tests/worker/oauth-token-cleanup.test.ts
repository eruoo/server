import { createScheduledController, env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
  OAUTH_RESOURCE,
} from "../../src/shared/oauth"
import worker from "../../src/worker"
import {
  cleanupExpiredOAuthTokenState,
  createOAuthRefreshFamilyRevocationCutoff,
  OAUTH_REFRESH_FAMILY_REVOCATION_RETENTION_MS,
} from "../../src/worker/auth/oauth-token-cleanup"
import { DAILY_CLEANUP_SCHEDULE } from "../../src/worker/schedules"

const now = 2_000_000_000_000
const clientId = "eruoo-desktop"
const userId = "oauth-cleanup-owner"

function storedDate(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

async function insertRefreshToken(options: {
  authorizationCodeId: string
  expiresAt: number
  id: string
  replayExpiresAt?: number
  replayResponse?: string
  revokedAt?: number | null
  rotatedAt?: number | null
  storedToken?: string
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauthRefreshToken (
       id, token, clientId, userId, authorizationCodeId, expiresAt, createdAt,
       revoked, rotatedAt, rotationReplayResponse, rotationReplayExpiresAt,
       scopes
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      options.id,
      options.storedToken ?? `stored-${options.id}`,
      clientId,
      userId,
      options.authorizationCodeId,
      storedDate(options.expiresAt),
      storedDate(now - 60_000),
      options.revokedAt === undefined
        ? storedDate(now - 60_000)
        : options.revokedAt === null
          ? null
          : storedDate(options.revokedAt),
      options.rotatedAt === undefined
        ? storedDate(now - 60_000)
        : options.rotatedAt === null
          ? null
          : storedDate(options.rotatedAt),
      options.replayResponse ?? null,
      options.replayExpiresAt === undefined
        ? null
        : storedDate(options.replayExpiresAt),
      JSON.stringify(["offline_access"]),
    )
    .run()
}

async function hashStoredOAuthToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  )
  const bytes = new Uint8Array(digest)
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

async function insertAccessToken(options: {
  expiresAt: number
  id: string
  refreshId?: string
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauthAccessToken (
       id, token, clientId, userId, refreshId, expiresAt, createdAt, scopes
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      options.id,
      `stored-${options.id}`,
      clientId,
      userId,
      options.refreshId ?? null,
      storedDate(options.expiresAt),
      storedDate(now - 60_000),
      JSON.stringify(["api:read"]),
    )
    .run()
}

async function insertFamilyRevocation(
  authorizationCodeId: string,
  revokedAt: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauthRefreshTokenFamilyRevocation (
       authorizationCodeId, clientId, userId, revokedAt
     ) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(authorizationCodeId, clientId, userId, revokedAt)
    .run()
}

async function storedIds(table: "oauthAccessToken" | "oauthRefreshToken") {
  const rows = await env.DB.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{
    id: string
  }>()
  return rows.results.map(({ id }) => id)
}

async function storedFamilyIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT authorizationCodeId
     FROM oauthRefreshTokenFamilyRevocation
     ORDER BY authorizationCodeId`,
  ).all<{ authorizationCodeId: string }>()
  return rows.results.map(({ authorizationCodeId }) => authorizationCodeId)
}

describe("OAuth token scheduled cleanup", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await env.DB.prepare(
      "DROP TRIGGER IF EXISTS synthetic_oauth_cleanup_failure",
    ).run()
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauthAccessToken"),
      env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
      env.DB.prepare("DELETE FROM oauthRefreshToken"),
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM verification"),
      env.DB.prepare("DELETE FROM user WHERE id = ?1").bind(userId),
    ])
    await env.DB.prepare(
      `INSERT INTO user (
         id, name, email, emailVerified, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(
        userId,
        "OAuth cleanup owner",
        "oauth-cleanup@example.invalid",
        storedDate(now - 60_000),
      )
      .run()
  })

  it("derives a safe 31-day family-revocation cutoff", () => {
    expect(OAUTH_REFRESH_FAMILY_REVOCATION_RETENTION_MS).toBe(
      (OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS + 24 * 60 * 60) * 1000,
    )
    expect(createOAuthRefreshFamilyRevocationCutoff(now)).toBe(
      now - OAUTH_REFRESH_FAMILY_REVOCATION_RETENTION_MS,
    )
    expect(() => createOAuthRefreshFamilyRevocationCutoff(Number.NaN)).toThrow(
      "OAuth token cleanup boundary is invalid",
    )
    expect(() => createOAuthRefreshFamilyRevocationCutoff(-1)).toThrow(
      "OAuth token cleanup boundary is invalid",
    )
    expect(() =>
      createOAuthRefreshFamilyRevocationCutoff(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("OAuth token cleanup boundary is invalid")
  })

  it("clears only replay payloads whose retry window is before the boundary", async () => {
    await insertRefreshToken({
      authorizationCodeId: "family-expired-replay",
      expiresAt: now + 60_000,
      id: "expired-replay",
      replayExpiresAt: now - 1,
      replayResponse: "encrypted-successor-credentials",
    })
    await insertRefreshToken({
      authorizationCodeId: "family-boundary-replay",
      expiresAt: now + 60_000,
      id: "boundary-replay",
      replayExpiresAt: now,
      replayResponse: "boundary-payload",
    })
    await insertRefreshToken({
      authorizationCodeId: "family-live-replay",
      expiresAt: now + 60_000,
      id: "live-replay",
      replayExpiresAt: now + 1,
      replayResponse: "live-payload",
    })

    const result = await cleanupExpiredOAuthTokenState(env.DB, now)
    const rows = await env.DB.prepare(
      `SELECT id, rotatedAt, rotationReplayExpiresAt, rotationReplayResponse
       FROM oauthRefreshToken
       ORDER BY id`,
    ).all<{
      id: string
      rotatedAt: string
      rotationReplayExpiresAt: string
      rotationReplayResponse: string | null
    }>()

    expect(result).toEqual({
      clearedReplayResponses: 1,
      deletedAccessTokens: 0,
      deletedFamilyRevocations: 0,
      deletedRefreshTokens: 0,
    })
    expect(rows.results).toEqual([
      expect.objectContaining({
        id: "boundary-replay",
        rotationReplayResponse: "boundary-payload",
      }),
      expect.objectContaining({
        id: "expired-replay",
        rotatedAt: storedDate(now - 60_000),
        rotationReplayExpiresAt: storedDate(now - 1),
        rotationReplayResponse: null,
      }),
      expect.objectContaining({
        id: "live-replay",
        rotationReplayResponse: "live-payload",
      }),
    ])
  })

  it("deletes expired tokens while retaining the boundary and active children", async () => {
    await insertRefreshToken({
      authorizationCodeId: "family-expired",
      expiresAt: now - 1,
      id: "expired-refresh",
    })
    await insertAccessToken({
      expiresAt: now - 1,
      id: "expired-access",
      refreshId: "expired-refresh",
    })
    await insertRefreshToken({
      authorizationCodeId: "family-boundary",
      expiresAt: now,
      id: "boundary-refresh",
    })
    await insertAccessToken({
      expiresAt: now,
      id: "boundary-access",
      refreshId: "boundary-refresh",
    })
    await insertRefreshToken({
      authorizationCodeId: "family-protected",
      expiresAt: now - 1,
      id: "protected-refresh",
    })
    await insertAccessToken({
      expiresAt: now + 1,
      id: "live-access",
      refreshId: "protected-refresh",
    })

    const result = await cleanupExpiredOAuthTokenState(env.DB, now)

    expect(result.deletedAccessTokens).toBe(1)
    expect(result.deletedRefreshTokens).toBe(1)
    await expect(storedIds("oauthAccessToken")).resolves.toEqual([
      "boundary-access",
      "live-access",
    ])
    await expect(storedIds("oauthRefreshToken")).resolves.toEqual([
      "boundary-refresh",
      "protected-refresh",
    ])
  })

  it("retains a tombstone until no unexpired family token remains", async () => {
    const cutoff = createOAuthRefreshFamilyRevocationCutoff(now)
    await insertRefreshToken({
      authorizationCodeId: "family-live",
      expiresAt: now + 1,
      id: "live-family-token",
    })
    await insertFamilyRevocation("family-live", cutoff - 1)
    await insertRefreshToken({
      authorizationCodeId: "family-boundary",
      expiresAt: now,
      id: "boundary-family-token",
    })
    await insertFamilyRevocation("family-boundary", cutoff - 1)
    await insertRefreshToken({
      authorizationCodeId: "family-expired",
      expiresAt: now - 1,
      id: "expired-family-token",
    })
    await insertFamilyRevocation("family-expired", cutoff - 1)
    await insertFamilyRevocation("family-orphan", cutoff - 1)
    await insertFamilyRevocation("family-retention-boundary", cutoff)
    await insertFamilyRevocation("family-recent-orphan", cutoff + 1)

    const result = await cleanupExpiredOAuthTokenState(env.DB, now)

    expect(result.deletedRefreshTokens).toBe(1)
    expect(result.deletedFamilyRevocations).toBe(2)
    await expect(storedFamilyIds()).resolves.toEqual([
      "family-boundary",
      "family-live",
      "family-recent-orphan",
      "family-retention-boundary",
    ])
  })

  it("keeps a recent tombstone capable of rejecting a late rotation successor", async () => {
    const familyId = "family-late-successor"
    const rawSuccessor = "late-successor-refresh-token"
    await insertRefreshToken({
      authorizationCodeId: familyId,
      expiresAt: now - 1,
      id: "expired-rotation-parent",
    })
    await insertFamilyRevocation(familyId, now - 60_000)

    const cleanup = await cleanupExpiredOAuthTokenState(env.DB, now)
    expect(cleanup).toMatchObject({
      deletedFamilyRevocations: 0,
      deletedRefreshTokens: 1,
    })

    await insertRefreshToken({
      authorizationCodeId: familyId,
      expiresAt: now + OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS * 1000,
      id: "late-rotation-successor",
      revokedAt: null,
      rotatedAt: null,
      storedToken: await hashStoredOAuthToken(rawSuccessor),
    })
    const successorBeforeRequest = await env.DB.prepare(
      `SELECT revoked, rotatedAt
       FROM oauthRefreshToken
       WHERE id = 'late-rotation-successor'`,
    ).first<{ revoked: string | null; rotatedAt: string | null }>()
    expect(successorBeforeRequest).toEqual({
      revoked: null,
      rotatedAt: null,
    })

    const response = await SELF.fetch(
      "http://local.test/api/auth/oauth2/token",
      {
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: rawSuccessor,
          resource: OAUTH_RESOURCE,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
    const successorAfterRequest = await env.DB.prepare(
      `SELECT revoked, rotatedAt
       FROM oauthRefreshToken
       WHERE id = 'late-rotation-successor'`,
    ).first<{ revoked: string | null; rotatedAt: string | null }>()
    expect(successorAfterRequest).toEqual({
      revoked: expect.any(String),
      rotatedAt: null,
    })
    await expect(storedFamilyIds()).resolves.toEqual([familyId])
  })

  it("uses indexes for every scheduled cleanup predicate", async () => {
    const boundary = storedDate(now)
    const statements = [
      {
        indexes: ["oauthRefreshToken_rotationReplayExpiresAt_idx"],
        sql: `UPDATE oauthRefreshToken
              SET rotationReplayResponse = NULL
              WHERE rotationReplayResponse IS NOT NULL
                AND rotationReplayExpiresAt < ?1`,
        values: [boundary],
      },
      {
        indexes: ["oauthAccessToken_expiresAt_idx"],
        sql: `DELETE FROM oauthAccessToken WHERE expiresAt < ?1`,
        values: [boundary],
      },
      {
        indexes: [
          "oauthRefreshToken_expiresAt_idx",
          "oauthAccessToken_refreshId_idx",
        ],
        sql: `DELETE FROM oauthRefreshToken AS refresh
              WHERE refresh.expiresAt < ?1
                AND NOT EXISTS (
                  SELECT 1 FROM oauthAccessToken AS access
                  WHERE access.refreshId = refresh.id
                    AND access.expiresAt >= ?1
                )`,
        values: [boundary],
      },
      {
        indexes: [
          "oauthRefreshTokenFamilyRevocation_revokedAt_idx",
          "oauthRefreshToken_family_expiresAt_idx",
        ],
        sql: `DELETE FROM oauthRefreshTokenFamilyRevocation AS revocation
              WHERE revocation.revokedAt < ?1
                AND NOT EXISTS (
                  SELECT 1 FROM oauthRefreshToken AS refresh
                  WHERE refresh.authorizationCodeId = revocation.authorizationCodeId
                    AND refresh.clientId = revocation.clientId
                    AND refresh.userId = revocation.userId
                    AND refresh.expiresAt >= ?2
                )`,
        values: [createOAuthRefreshFamilyRevocationCutoff(now), boundary],
      },
    ] as const

    for (const statement of statements) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .bind(...statement.values)
        .all<{ detail: string }>()
      const details = plan.results.map(({ detail }) => detail).join("\n")
      for (const index of statement.indexes) expect(details).toContain(index)
    }
  })

  it("rejects an invalid boundary before preparing cleanup mutations", async () => {
    await insertRefreshToken({
      authorizationCodeId: "family-invalid-boundary",
      expiresAt: now - 1,
      id: "invalid-boundary-token",
    })

    await expect(
      cleanupExpiredOAuthTokenState(env.DB, Number.NaN),
    ).rejects.toThrow("OAuth token cleanup boundary is invalid")
    await expect(storedIds("oauthRefreshToken")).resolves.toEqual([
      "invalid-boundary-token",
    ])
  })

  it("propagates a failed OAuth cleanup batch through the scheduled handler", async () => {
    await insertRefreshToken({
      authorizationCodeId: "family-failure",
      expiresAt: now + 60_000,
      id: "failure-token",
      replayExpiresAt: now - 1,
      replayResponse: "must-survive-rollback",
    })
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_oauth_cleanup_failure
       BEFORE UPDATE OF rotationReplayResponse ON oauthRefreshToken
       WHEN OLD.id = 'failure-token'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic oauth cleanup failure');
       END`,
    ).run()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await expect(
        worker.scheduled(
          createScheduledController({
            cron: DAILY_CLEANUP_SCHEDULE,
            scheduledTime: now,
          }),
          env,
        ),
      ).rejects.toThrow("synthetic oauth cleanup failure")
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "scheduled_cleanup_failed" }),
      )
      const stored = await env.DB.prepare(
        `SELECT rotationReplayResponse
         FROM oauthRefreshToken
         WHERE id = 'failure-token'`,
      ).first<{ rotationReplayResponse: string }>()
      expect(stored?.rotationReplayResponse).toBe("must-survive-rollback")
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS synthetic_oauth_cleanup_failure",
      ).run()
    }
  })
})

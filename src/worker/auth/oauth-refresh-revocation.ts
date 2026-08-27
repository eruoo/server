import type { MiddlewareHandler } from "hono"

import { scheduleAuditEvent } from "../audit"
import type { AppBindings } from "../http/types"
import { parseOAuthFormRequest } from "./oauth-protocol"

interface RefreshFamilyCapture {
  authorizationCodeId: string
  clientId: string
  expiresAt: number
  familyRevoked: number
  revokedAt: number | null
  rotatedAt: number | null
  rotationReplayExpiresAt: number | null
  userId: string
}

interface StoredRefreshFamilyCapture {
  authorizationCodeId: unknown
  clientId: unknown
  expiresAt: unknown
  familyRevoked: unknown
  revoked: unknown
  rotatedAt: unknown
  rotationReplayExpiresAt: unknown
  userId: unknown
}

type RefreshFamilyOperation = "refresh" | "revoke"

function invalidRefreshTokenResponse(): Response {
  return Response.json(
    {
      error: "invalid_grant",
      error_description: "invalid refresh token",
    },
    {
      headers: { "Cache-Control": "no-store" },
      status: 400,
    },
  )
}

function successfulRevocationResponse(): Response {
  return new Response(null, {
    headers: { "Cache-Control": "no-store" },
    status: 200,
  })
}

async function isInvalidRefreshGrantResponse(
  response: Response,
): Promise<boolean> {
  if (
    response.status !== 400 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return false
  }

  try {
    const body: unknown = await response.clone().json()
    return (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      body.error === "invalid_grant"
    )
  } catch {
    return false
  }
}

function exactlyOne(values: URLSearchParams, name: string): string | undefined {
  const entries = values.getAll(name)
  return entries.length === 1 ? entries[0] : undefined
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

function parseRefreshFamilyCapture(
  row: StoredRefreshFamilyCapture | null,
): RefreshFamilyCapture | undefined {
  if (row === null) return undefined
  if (
    typeof row.authorizationCodeId !== "string" ||
    row.authorizationCodeId.length === 0 ||
    typeof row.clientId !== "string" ||
    row.clientId.length === 0 ||
    (row.familyRevoked !== 0 && row.familyRevoked !== 1) ||
    typeof row.userId !== "string" ||
    row.userId.length === 0
  ) {
    throw new TypeError("Stored OAuth refresh family data is invalid")
  }

  const expiresAt = parseStoredTimestamp(row.expiresAt)
  if (expiresAt === null) {
    throw new TypeError("Stored OAuth refresh family data is invalid")
  }

  return {
    authorizationCodeId: row.authorizationCodeId,
    clientId: row.clientId,
    expiresAt,
    familyRevoked: row.familyRevoked,
    revokedAt: parseStoredTimestamp(row.revoked),
    rotatedAt: parseStoredTimestamp(row.rotatedAt),
    rotationReplayExpiresAt: parseStoredTimestamp(row.rotationReplayExpiresAt),
    userId: row.userId,
  }
}

function parseStoredTimestamp(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== "number" && typeof value !== "string") {
    throw new TypeError("Stored OAuth refresh family data is invalid")
  }

  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Stored OAuth refresh family data is invalid")
  }
  return timestamp
}

async function captureRefreshFamily(
  database: D1Database,
  rawToken: string,
): Promise<RefreshFamilyCapture | undefined> {
  const session = database.withSession("first-primary")
  const row = await session
    .prepare(
      `SELECT refresh.authorizationCodeId,
              refresh.clientId,
              refresh.expiresAt,
              refresh.revoked,
              refresh.rotatedAt,
              refresh.rotationReplayExpiresAt,
              refresh.userId,
              EXISTS (
                SELECT 1
                FROM oauthRefreshTokenFamilyRevocation AS revocation
                WHERE revocation.authorizationCodeId = refresh.authorizationCodeId
                  AND revocation.clientId = refresh.clientId
                  AND revocation.userId = refresh.userId
              ) AS familyRevoked
       FROM oauthRefreshToken AS refresh
       WHERE refresh.token = ?1
       LIMIT 1`,
    )
    .bind(await hashStoredOAuthToken(rawToken))
    .first<StoredRefreshFamilyCapture>()

  return parseRefreshFamilyCapture(row)
}

function isReuseOutsideRetryWindow(
  family: RefreshFamilyCapture,
  observedAt: number,
): boolean {
  return (
    family.revokedAt !== null &&
    family.rotatedAt !== null &&
    family.expiresAt > observedAt &&
    family.rotationReplayExpiresAt !== null &&
    family.rotationReplayExpiresAt < observedAt
  )
}

async function tombstoneRefreshFamily(
  database: D1Database,
  family: RefreshFamilyCapture,
  observedAt: number,
): Promise<boolean> {
  const result = await database
    .prepare(
      `INSERT INTO oauthRefreshTokenFamilyRevocation (
         authorizationCodeId, clientId, userId, revokedAt
       ) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (authorizationCodeId, clientId, userId) DO NOTHING`,
    )
    .bind(
      family.authorizationCodeId,
      family.clientId,
      family.userId,
      observedAt,
    )
    .run()

  if (
    !Number.isSafeInteger(result.meta.changes) ||
    result.meta.changes < 0 ||
    result.meta.changes > 1
  ) {
    throw new TypeError("OAuth refresh family tombstone result is invalid")
  }

  return result.meta.changes === 1
}

function readFamilyRevocation(result: D1Result<unknown> | undefined): boolean {
  const row = result?.results[0]
  if (
    result?.results.length !== 1 ||
    typeof row !== "object" ||
    row === null ||
    !("familyRevoked" in row) ||
    (row.familyRevoked !== 0 && row.familyRevoked !== 1)
  ) {
    throw new TypeError("Stored OAuth refresh family revocation is invalid")
  }
  return row.familyRevoked === 1
}

async function revokeFamilyIfTombstoned(
  database: D1Database,
  family: RefreshFamilyCapture,
): Promise<boolean> {
  const revokedAt = new Date().toISOString()
  const results = await database.batch<unknown>([
    database
      .prepare(
        `UPDATE oauthRefreshToken
         SET revoked = ?1
         WHERE authorizationCodeId = ?2
           AND clientId = ?3
           AND userId = ?4
           AND revoked IS NULL
           AND EXISTS (
             SELECT 1
             FROM oauthRefreshTokenFamilyRevocation AS revocation
             WHERE revocation.authorizationCodeId = ?2
               AND revocation.clientId = ?3
               AND revocation.userId = ?4
           )`,
      )
      .bind(
        revokedAt,
        family.authorizationCodeId,
        family.clientId,
        family.userId,
      ),
    database
      .prepare(
        `SELECT EXISTS (
           SELECT 1
           FROM oauthRefreshTokenFamilyRevocation
           WHERE authorizationCodeId = ?1
             AND clientId = ?2
             AND userId = ?3
         ) AS familyRevoked`,
      )
      .bind(family.authorizationCodeId, family.clientId, family.userId),
  ])

  if (results.length !== 2) {
    throw new TypeError("OAuth refresh family revocation result is invalid")
  }
  return readFamilyRevocation(results[1])
}

/**
 * Keeps owner revocation, native logout, and detected refresh reuse linearizable
 * with Better Auth's multi-statement refresh rotation. The family tombstone is
 * keyed by authorizationCodeId, which Better Auth copies to every successor.
 */
export const enforceOAuthRefreshFamilyRevocation: MiddlewareHandler<
  AppBindings
> = async (context, next) => {
  const values = await parseOAuthFormRequest(context.req.raw)
  if (!values) {
    await next()
    return
  }

  let operation: RefreshFamilyOperation
  let rawRefreshToken: string | undefined
  if (
    context.req.path === "/api/auth/oauth2/token" &&
    exactlyOne(values, "grant_type") === "refresh_token"
  ) {
    operation = "refresh"
    rawRefreshToken = exactlyOne(values, "refresh_token")
  } else if (context.req.path === "/api/auth/oauth2/revoke") {
    operation = "revoke"
    rawRefreshToken = exactlyOne(values, "token")
  } else {
    await next()
    return
  }

  const requestedClientId = exactlyOne(values, "client_id")
  if (!rawRefreshToken || !requestedClientId) {
    await next()
    return
  }

  const family = await captureRefreshFamily(context.env.DB, rawRefreshToken)
  if (!family || family.clientId !== requestedClientId) {
    await next()
    return
  }
  if (operation === "revoke") {
    context.set("oauthRefreshFamilyRevocationManaged", true)
  }
  if (
    family.familyRevoked === 1 &&
    (await revokeFamilyIfTombstoned(context.env.DB, family))
  ) {
    context.res =
      operation === "refresh"
        ? invalidRefreshTokenResponse()
        : successfulRevocationResponse()
    return
  }

  const observedAt = Date.now()
  let tombstoneCreatedBeforeDownstream = false
  let tombstoneEstablishedBeforeDownstream = false
  if (
    (operation === "refresh" &&
      isReuseOutsideRetryWindow(family, observedAt)) ||
    (operation === "revoke" && family.expiresAt > observedAt)
  ) {
    const tombstoneCreated = await tombstoneRefreshFamily(
      context.env.DB,
      family,
      observedAt,
    )
    tombstoneCreatedBeforeDownstream = tombstoneCreated
    tombstoneEstablishedBeforeDownstream = true
  }

  await next()

  const downstreamCompletedAt = Date.now()
  if (
    operation === "refresh" &&
    !tombstoneEstablishedBeforeDownstream &&
    isReuseOutsideRetryWindow(family, downstreamCompletedAt) &&
    (await isInvalidRefreshGrantResponse(context.res))
  ) {
    await tombstoneRefreshFamily(context.env.DB, family, downstreamCompletedAt)
  }

  const familyRevoked = await revokeFamilyIfTombstoned(context.env.DB, family)
  if (familyRevoked && operation === "refresh") {
    context.res = invalidRefreshTokenResponse()
  } else if (
    familyRevoked &&
    operation === "revoke" &&
    tombstoneCreatedBeforeDownstream &&
    context.res.status !== 429
  ) {
    scheduleAuditEvent(context, {
      clientId: family.clientId,
      metadata: { tokenType: "refresh_token" },
      outcome: context.res.ok ? "success" : "failure",
      subjectId: family.userId,
      type: "oauth_grant_revoked",
    })
  }
}

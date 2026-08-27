import { createHash } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import {
  captureOAuthProtocolAudit,
  scheduleOAuthProtocolAudit,
} from "../../src/worker/auth/oauth-audit"
import { enforceOAuthRefreshFamilyRevocation } from "../../src/worker/auth/oauth-refresh-revocation"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { oauthAuthorizationsRouter } from "../../src/worker/routes/oauth-authorizations"
import { createOwnerSession } from "./fixtures/owner-session"

const app = new OpenAPIHono<AppBindings>({ strict: true })
app.use("*", requestId)
app.route("/", oauthAuthorizationsRouter)

interface ConsentOptions {
  clientId?: string
  createdAt?: string | number
  id: string
  resources?: string | null
  scopes?: string
  updatedAt?: string | number
  userId: string
}

interface RefreshTokenOptions {
  authorizationCodeId?: string | null
  clientId?: string
  createdAt: string | number
  expiresAt: string | number
  id: string
  resources?: string | null
  revoked?: string | number | null
  rotatedAt?: string | number | null
  rotationReplayExpiresAt?: string | number | null
  scopes?: string
  token?: string
  userId: string
}

async function fetchAuthorization(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const executionContext = createExecutionContext()
  const response = await app.fetch(
    new Request(`http://local.test${path}`, init),
    env,
    executionContext,
  )
  await waitOnExecutionContext(executionContext)
  return response
}

async function currentOwnerId(): Promise<string> {
  const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
    id: string
  }>()

  if (!owner) throw new Error("Synthetic owner fixture was not created.")
  return owner.id
}

async function insertConsent(options: ConsentOptions): Promise<void> {
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO oauthConsent (
       id, clientId, userId, resources, scopes, createdAt, updatedAt
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      options.id,
      options.clientId ?? "eruoo-desktop",
      options.userId,
      options.resources ?? JSON.stringify([OAUTH_RESOURCE]),
      options.scopes ?? JSON.stringify(["openid"]),
      options.createdAt ?? now,
      options.updatedAt ?? now,
    )
    .run()
}

async function insertRefreshToken(options: RefreshTokenOptions): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauthRefreshToken (
       id, token, clientId, userId, authorizationCodeId, resources, expiresAt,
       createdAt, revoked, rotatedAt, rotationReplayExpiresAt, scopes
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      options.id,
      options.token ?? `token-${options.id}`,
      options.clientId ?? "eruoo-desktop",
      options.userId,
      options.authorizationCodeId ?? `family-${options.id}`,
      options.resources ?? JSON.stringify([OAUTH_RESOURCE]),
      options.expiresAt,
      options.createdAt,
      options.revoked ?? null,
      options.rotatedAt ?? null,
      options.rotationReplayExpiresAt ?? null,
      options.scopes ?? JSON.stringify(["openid", "offline_access"]),
    )
    .run()
}

describe("owner OAuth authorizations", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM oauthAccessToken"),
      env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
      env.DB.prepare("DELETE FROM oauthRefreshToken"),
      env.DB.prepare("DELETE FROM oauthConsent"),
      env.DB.prepare(
        "DELETE FROM oauthClientResource WHERE clientId <> 'eruoo-desktop'",
      ),
      env.DB.prepare(
        "DELETE FROM oauthClient WHERE clientId <> 'eruoo-desktop'",
      ),
      env.DB.prepare(
        "UPDATE oauthClient SET disabled = 0 WHERE clientId = 'eruoo-desktop'",
      ),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("registers the complete owner-only OpenAPI contract", () => {
    const document = oauthAuthorizationsRouter.getOpenAPI31Document({
      info: { title: "OAuth authorizations test", version: "test" },
      openapi: "3.1.0",
    })
    const listOperation = document.paths?.["/api/oauth/authorizations"]?.get
    const revokeOperation =
      document.paths?.["/api/oauth/authorizations/{clientId}"]?.delete
    const authorization = document.components?.schemas?.["OAuthAuthorization"]

    if (!authorization || !("properties" in authorization)) {
      throw new Error("The OAuth authorization schema is missing.")
    }

    expect(listOperation).toMatchObject({
      operationId: "listOAuthAuthorizations",
      security: [{ ownerSession: [] }],
    })
    expect(Object.keys(listOperation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "500",
      "503",
      "504",
    ])
    expect(revokeOperation).toMatchObject({
      operationId: "revokeOAuthAuthorization",
      security: [{ ownerSession: [] }],
    })
    expect(Object.keys(revokeOperation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "413",
      "429",
      "500",
      "503",
      "504",
    ])
    expect(authorization.properties?.["lastAuthorizedAt"]).toMatchObject({
      format: "int64",
    })
  })

  it.each([
    { headers: undefined, name: "missing credentials" },
    { headers: { "x-api-key": "eruoo_synthetic" }, name: "an API key" },
    {
      headers: { authorization: "Bearer synthetic.token" },
      name: "an OAuth access token",
    },
  ])("rejects $name for the authorization list", async ({ headers }) => {
    const response = await fetchAuthorization(
      "/api/oauth/authorizations",
      headers === undefined ? undefined : { headers },
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
  })

  it("rejects ambiguous credential carriers before reading authorization state", async () => {
    const response = await fetchAuthorization("/api/oauth/authorizations", {
      headers: {
        authorization: "Bearer synthetic.token",
        cookie: "eruoo.session_token=synthetic",
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
  })

  it.each([
    {
      expectedStatus: 401,
      headers: undefined,
      name: "missing credentials",
    },
    {
      expectedStatus: 401,
      headers: { "x-api-key": "eruoo_synthetic" },
      name: "an API key",
    },
    {
      expectedStatus: 400,
      headers: {
        cookie: "eruoo.session_token=synthetic",
        "x-api-key": "eruoo_synthetic",
      },
      name: "ambiguous credentials",
    },
  ])(
    "rejects $name for authorization revocation",
    async ({ expectedStatus, headers }) => {
      const response = await fetchAuthorization(
        "/api/oauth/authorizations/eruoo-desktop",
        {
          ...(headers === undefined ? {} : { headers }),
          method: "DELETE",
        },
      )

      expect(response.status).toBe(expectedStatus)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
    },
  )

  it("summarizes consents and only active refresh tokens in static client order", async () => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const latestAuthorization = new Date(now - 4_000).toISOString()

    await insertConsent({
      createdAt: new Date(now - 10_000).toISOString(),
      id: "consent-profile",
      scopes: JSON.stringify(["openid", "profile", "offline_access"]),
      updatedAt: new Date(now - 8_000).toISOString(),
      userId,
    })
    await insertConsent({
      createdAt: new Date(now - 7_000).toISOString(),
      id: "consent-api-read",
      resources: null,
      scopes: JSON.stringify(["api:read"]),
      updatedAt: new Date(now - 6_000).toISOString(),
      userId,
    })
    await insertRefreshToken({
      createdAt: latestAuthorization,
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "active-refresh",
      scopes: JSON.stringify(["api:write", "offline_access"]),
      userId,
    })
    await insertRefreshToken({
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
      id: "expired-refresh",
      scopes: JSON.stringify(["api:read", "offline_access"]),
      userId,
    })
    await insertRefreshToken({
      createdAt: new Date(now - 50_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "rotated-refresh",
      rotatedAt: new Date(now - 20_000).toISOString(),
      userId,
    })
    await insertRefreshToken({
      createdAt: new Date(now - 50_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "revoked-refresh",
      revoked: new Date(now - 10_000).toISOString(),
      userId,
    })

    const response = await fetchAuthorization("/api/oauth/authorizations", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })
    const authorizations = await response.json<Array<Record<string, unknown>>>()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(authorizations).toEqual([
      {
        activeRefreshTokenCount: 0,
        authorized: false,
        clientId: "eruoo-web",
        consentCount: 0,
        enabled: false,
        lastAuthorizedAt: null,
        name: "eruoo Web",
        offlineAccess: false,
        platform: "web",
        resources: [],
        scopes: [],
        supportsOfflineAccess: false,
      },
      {
        activeRefreshTokenCount: 1,
        authorized: true,
        clientId: "eruoo-desktop",
        consentCount: 2,
        enabled: true,
        lastAuthorizedAt: Date.parse(latestAuthorization),
        name: "eruoo Desktop",
        offlineAccess: true,
        platform: "desktop",
        resources: [OAUTH_RESOURCE],
        scopes: [
          "api:read",
          "api:write",
          "offline_access",
          "openid",
          "profile",
        ],
        supportsOfflineAccess: true,
      },
      {
        activeRefreshTokenCount: 0,
        authorized: false,
        clientId: "eruoo-mobile",
        consentCount: 0,
        enabled: false,
        lastAuthorizedAt: null,
        name: "eruoo Mobile",
        offlineAccess: false,
        platform: "mobile",
        resources: [],
        scopes: [],
        supportsOfflineAccess: true,
      },
    ])
  })

  it("fails closed when D1 contains an unknown OAuth client", async () => {
    const cookie = await createOwnerSession()
    await env.DB.prepare(
      `INSERT INTO oauthClient (id, clientId, disabled, redirectUris)
       VALUES (?1, ?2, 0, '[]')`,
    )
      .bind("unknown-client-row", "unknown-client")
      .run()

    const response = await fetchAuthorization("/api/oauth/authorizations", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/service-unavailable",
    })
  })

  it.each([
    {
      field: "scopes",
      overrides: { scopes: "not-json" },
    },
    {
      field: "updatedAt",
      overrides: { updatedAt: "not-a-date" },
    },
    {
      field: "ambiguous updatedAt",
      overrides: { updatedAt: "08/23/2026" },
    },
  ])("fails closed for malformed stored $field", async ({ overrides }) => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    await insertConsent({ id: "malformed-consent", userId, ...overrides })

    const response = await fetchAuthorization("/api/oauth/authorizations", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: 503,
      type: "https://auth.eruoo.me/problems/service-unavailable",
    })
  })

  it("revokes every unrevoked refresh token and consent without touching access tokens", async () => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()

    await insertConsent({ id: "consent-one", userId })
    await insertConsent({ id: "consent-two", userId })
    await insertRefreshToken({
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "active-refresh",
      userId,
    })
    await insertRefreshToken({
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
      id: "expired-refresh",
      userId,
    })
    const existingRevokedAt = new Date(now - 20_000).toISOString()
    await insertRefreshToken({
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "already-revoked-refresh",
      revoked: existingRevokedAt,
      userId,
    })
    await env.DB.prepare(
      `INSERT INTO oauthAccessToken (
         id, token, clientId, userId, refreshId, resources, expiresAt,
         createdAt, revoked, scopes
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)`,
    )
      .bind(
        "signed-access-token",
        "signed-access-token-value",
        "eruoo-desktop",
        userId,
        "active-refresh",
        JSON.stringify([OAUTH_RESOURCE]),
        new Date(now + 60_000).toISOString(),
        new Date(now - 1_000).toISOString(),
        JSON.stringify(["api:read"]),
      )
      .run()

    const response = await fetchAuthorization(
      "/api/oauth/authorizations/eruoo-desktop",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
        method: "DELETE",
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toEqual({
      clientId: "eruoo-desktop",
      deletedConsentCount: 2,
      revokedRefreshTokenCount: 2,
    })

    const refreshTokens = await env.DB.prepare(
      `SELECT id, revoked
       FROM oauthRefreshToken
       ORDER BY id ASC`,
    ).all<{ id: string; revoked: string | null }>()
    const consents = await env.DB.prepare(
      "SELECT id FROM oauthConsent WHERE userId = ?1",
    )
      .bind(userId)
      .all()
    const accessToken = await env.DB.prepare(
      "SELECT id, revoked FROM oauthAccessToken WHERE id = ?1",
    )
      .bind("signed-access-token")
      .first<{ id: string; revoked: string | null }>()
    const audit = await env.DB.prepare(
      `SELECT clientId, metadata, outcome, subjectId, type
       FROM security_audit_events
       WHERE type = 'oauth_grant_revoked'
       ORDER BY occurredAt DESC
       LIMIT 1`,
    ).first<{
      clientId: string
      metadata: string
      outcome: string
      subjectId: string
      type: string
    }>()

    expect(refreshTokens.results).toEqual([
      { id: "active-refresh", revoked: expect.any(String) },
      { id: "already-revoked-refresh", revoked: existingRevokedAt },
      { id: "expired-refresh", revoked: expect.any(String) },
    ])
    const revokedFamilies = await env.DB.prepare(
      `SELECT authorizationCodeId, clientId, userId
       FROM oauthRefreshTokenFamilyRevocation
       ORDER BY authorizationCodeId`,
    ).all<{
      authorizationCodeId: string
      clientId: string
      userId: string
    }>()
    expect(revokedFamilies.results).toEqual([
      {
        authorizationCodeId: "family-active-refresh",
        clientId: "eruoo-desktop",
        userId,
      },
      {
        authorizationCodeId: "family-already-revoked-refresh",
        clientId: "eruoo-desktop",
        userId,
      },
      {
        authorizationCodeId: "family-expired-refresh",
        clientId: "eruoo-desktop",
        userId,
      },
    ])
    expect(consents.results).toEqual([])
    expect(accessToken).toEqual({ id: "signed-access-token", revoked: null })
    expect(audit).toMatchObject({
      clientId: "eruoo-desktop",
      outcome: "success",
      subjectId: userId,
      type: "oauth_grant_revoked",
    })
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
      deletedConsentCount: 2,
      revokedRefreshTokenCount: 2,
    })
  })

  it("rejects a JSON body access token before owner revocation mutates state", async () => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()

    await insertConsent({ id: "preserved-body-token-consent", userId })
    await insertRefreshToken({
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "preserved-body-token-refresh",
      userId,
    })

    const response = await fetchAuthorization(
      "/api/oauth/authorizations/eruoo-desktop",
      {
        body: JSON.stringify({ access_token: "synthetic-access-token" }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
        },
        method: "DELETE",
      },
    )
    const consent = await env.DB.prepare(
      "SELECT id FROM oauthConsent WHERE id = 'preserved-body-token-consent'",
    ).first<{ id: string }>()
    const refreshToken = await env.DB.prepare(
      `SELECT id, revoked
       FROM oauthRefreshToken
       WHERE id = 'preserved-body-token-refresh'`,
    ).first<{ id: string; revoked: string | null }>()

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
    expect(consent).toEqual({ id: "preserved-body-token-consent" })
    expect(refreshToken).toEqual({
      id: "preserved-body-token-refresh",
      revoked: null,
    })
  })

  it("invalidates a refresh successor inserted after owner revocation", async () => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const authorizationCodeId = "racing-authorization-code"
    const originalToken = "racing-original-refresh-token"
    const successorToken = "racing-successor-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    await insertConsent({ id: "racing-consent", userId })
    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "racing-original-refresh",
      token: storedToken(originalToken),
      userId,
    })

    let downstreamCalls = 0
    const refreshApp = new OpenAPIHono<AppBindings>({ strict: true })
    refreshApp.use("*", requestId)
    refreshApp.use(
      "/api/auth/oauth2/token",
      enforceOAuthRefreshFamilyRevocation,
    )
    refreshApp.post("/api/auth/oauth2/token", async (context) => {
      downstreamCalls += 1
      const rotatedAt = new Date().toISOString()
      await env.DB.prepare(
        `UPDATE oauthRefreshToken
         SET revoked = ?1, rotatedAt = ?1
         WHERE id = 'racing-original-refresh' AND revoked IS NULL`,
      )
        .bind(rotatedAt)
        .run()

      const ownerRevocation = await fetchAuthorization(
        "/api/oauth/authorizations/eruoo-desktop",
        {
          headers: { cookie: `eruoo.session_token=${cookie}` },
          method: "DELETE",
        },
      )
      expect(ownerRevocation.status).toBe(200)

      await insertRefreshToken({
        authorizationCodeId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        id: "racing-successor-refresh",
        token: storedToken(successorToken),
        userId,
      })

      return context.json({
        access_token: "synthetic-access-token",
        refresh_token: successorToken,
        token_type: "Bearer",
      })
    })

    const requestRefresh = (token: string) =>
      refreshApp.fetch(
        new Request("http://local.test/api/auth/oauth2/token", {
          body: new URLSearchParams({
            client_id: "eruoo-desktop",
            grant_type: "refresh_token",
            refresh_token: token,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        env,
        createExecutionContext(),
      )

    const raced = await requestRefresh(originalToken)
    expect(raced.status).toBe(400)
    await expect(raced.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "invalid refresh token",
    })
    expect(downstreamCalls).toBe(1)
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'racing-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })

    const staleSuccessor = await requestRefresh(successorToken)
    expect(staleSuccessor.status).toBe(400)
    await expect(staleSuccessor.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
    expect(downstreamCalls).toBe(1)
  })

  it("tombstones detected reuse before a concurrent successor is inserted", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const authorizationCodeId = "reused-authorization-code"
    const originalToken = "reused-original-refresh-token"
    const successorToken = "reused-successor-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "reused-original-refresh",
      revoked: new Date(now - 40_000).toISOString(),
      rotatedAt: new Date(now - 40_000).toISOString(),
      token: storedToken(originalToken),
      userId,
    })
    await env.DB.prepare(
      `UPDATE oauthRefreshToken
       SET rotationReplayExpiresAt = ?1
       WHERE id = 'reused-original-refresh'`,
    )
      .bind(new Date(now - 1_000).toISOString())
      .run()
    await insertRefreshToken({
      authorizationCodeId: "independent-authorization-code",
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "independent-refresh",
      userId,
    })

    let downstreamCalls = 0
    const refreshApp = new OpenAPIHono<AppBindings>({ strict: true })
    refreshApp.use("*", requestId)
    refreshApp.use(
      "/api/auth/oauth2/token",
      enforceOAuthRefreshFamilyRevocation,
    )
    refreshApp.post("/api/auth/oauth2/token", async (context) => {
      downstreamCalls += 1
      const tombstone = await env.DB.prepare(
        `SELECT revokedAt
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1
           AND clientId = 'eruoo-desktop'
           AND userId = ?2`,
      )
        .bind(authorizationCodeId, userId)
        .first<{ revokedAt: number }>()
      expect(tombstone?.revokedAt).toEqual(expect.any(Number))

      await insertRefreshToken({
        authorizationCodeId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        id: "reused-successor-refresh",
        token: storedToken(successorToken),
        userId,
      })

      return context.json({
        access_token: "synthetic-access-token",
        refresh_token: successorToken,
        token_type: "Bearer",
      })
    })

    const requestRefresh = (token: string) =>
      refreshApp.fetch(
        new Request("http://local.test/api/auth/oauth2/token", {
          body: new URLSearchParams({
            client_id: "eruoo-desktop",
            grant_type: "refresh_token",
            refresh_token: token,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        env,
        createExecutionContext(),
      )

    const raced = await requestRefresh(originalToken)
    expect(raced.status).toBe(400)
    await expect(raced.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "invalid refresh token",
    })
    expect(downstreamCalls).toBe(1)
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'reused-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'independent-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: null })

    const staleSuccessor = await requestRefresh(successorToken)
    expect(staleSuccessor.status).toBe(400)
    expect(downstreamCalls).toBe(1)
  })

  it("tombstones refresh revocation before a concurrent successor is inserted", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const authorizationCodeId = "logout-authorization-code"
    const lateSuccessorToken = "logout-late-successor-refresh-token"
    const originalToken = "logout-original-refresh-token"
    const successorToken = "logout-successor-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "logout-original-refresh",
      token: storedToken(originalToken),
      userId,
    })
    await insertRefreshToken({
      authorizationCodeId: "logout-independent-authorization-code",
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "logout-independent-refresh",
      userId,
    })

    let refreshDownstreamCalls = 0
    let revokeDownstreamCalls = 0
    const oauthApp = new OpenAPIHono<AppBindings>({ strict: true })
    oauthApp.use("*", requestId)
    oauthApp.use("/api/auth/oauth2/revoke", enforceOAuthRefreshFamilyRevocation)
    oauthApp.use("/api/auth/oauth2/token", enforceOAuthRefreshFamilyRevocation)
    oauthApp.post("/api/auth/oauth2/revoke", async (context) => {
      revokeDownstreamCalls += 1
      const tombstone = await env.DB.prepare(
        `SELECT revokedAt
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1
           AND clientId = 'eruoo-desktop'
           AND userId = ?2`,
      )
        .bind(authorizationCodeId, userId)
        .first<{ revokedAt: number }>()
      expect(tombstone?.revokedAt).toEqual(expect.any(Number))

      await insertRefreshToken({
        authorizationCodeId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        id: "logout-successor-refresh",
        token: storedToken(successorToken),
        userId,
      })

      return context.body(null, 200)
    })
    oauthApp.post("/api/auth/oauth2/token", (context) => {
      refreshDownstreamCalls += 1
      return context.json({
        access_token: "synthetic-access-token",
        refresh_token: successorToken,
        token_type: "Bearer",
      })
    })

    const revoke = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/revoke", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          token: originalToken,
          token_type_hint: "refresh_token",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    )
    expect(revoke.status).toBe(200)
    expect(revokeDownstreamCalls).toBe(1)
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'logout-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'logout-independent-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: null })

    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "logout-late-successor-refresh",
      token: storedToken(lateSuccessorToken),
      userId,
    })

    const repeatedRevoke = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/revoke", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          token: originalToken,
          token_type_hint: "refresh_token",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    )
    expect(repeatedRevoke.status).toBe(200)
    expect(repeatedRevoke.headers.get("cache-control")).toBe("no-store")
    expect(revokeDownstreamCalls).toBe(1)
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'logout-late-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })

    const rejectedSuccessor = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/token", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          grant_type: "refresh_token",
          refresh_token: lateSuccessorToken,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    )
    expect(rejectedSuccessor.status).toBe(400)
    await expect(rejectedSuccessor.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
    expect(refreshDownstreamCalls).toBe(0)
  })

  it("does not audit a successful revoke before post-processing succeeds", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const rawToken = "post-processing-failure-refresh-token"
    const storedToken = createHash("sha256")
      .update(rawToken)
      .digest("base64url")

    await insertRefreshToken({
      authorizationCodeId: "post-processing-failure-family",
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "post-processing-failure-refresh",
      token: storedToken,
      userId,
    })

    const failingDatabase = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async () => {
            throw new Error("synthetic post-processing failure")
          }
        }

        const value: unknown = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const failingEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "DB"
          ? failingDatabase
          : Reflect.get(target, property, receiver)
      },
    })
    const oauthApp = new OpenAPIHono<AppBindings>({ strict: true })
    oauthApp.use("*", requestId)
    oauthApp.use("/api/auth/oauth2/revoke", enforceOAuthRefreshFamilyRevocation)
    oauthApp.use("/api/auth/oauth2/revoke", async (context, next) => {
      const auditCapture = await captureOAuthProtocolAudit(context)
      await next()
      scheduleOAuthProtocolAudit(context, auditCapture, context.res)
    })
    oauthApp.post("/api/auth/oauth2/revoke", async (context) => {
      await context.env.DB.prepare(
        `UPDATE oauthRefreshToken
         SET revoked = ?1
         WHERE id = 'post-processing-failure-refresh'`,
      )
        .bind(new Date().toISOString())
        .run()
      return context.body(null, 200)
    })

    const executionContext = createExecutionContext()
    const response = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/revoke", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          token: rawToken,
          token_type_hint: "refresh_token",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      failingEnv,
      executionContext,
    )
    await waitOnExecutionContext(executionContext)

    expect(response.status).toBe(500)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM security_audit_events
         WHERE type = 'oauth_grant_revoked'
           AND outcome = 'success'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })

  it("does not audit a managed revoke rejected by provider rate limiting", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const rawToken = "provider-rate-limited-refresh-token"

    await insertRefreshToken({
      authorizationCodeId: "provider-rate-limited-family",
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "provider-rate-limited-refresh",
      token: createHash("sha256").update(rawToken).digest("base64url"),
      userId,
    })

    const oauthApp = new OpenAPIHono<AppBindings>({ strict: true })
    oauthApp.use("*", requestId)
    oauthApp.use("/api/auth/oauth2/revoke", enforceOAuthRefreshFamilyRevocation)
    oauthApp.post("/api/auth/oauth2/revoke", (context) =>
      context.json({ error: "too_many_requests" }, 429),
    )

    const executionContext = createExecutionContext()
    const response = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/revoke", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          token: rawToken,
          token_type_hint: "refresh_token",
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      executionContext,
    )
    await waitOnExecutionContext(executionContext)

    expect(response.status).toBe(429)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM security_audit_events
         WHERE type = 'oauth_grant_revoked'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 })
  })

  it("tombstones and audits refresh reuse when the retry window expires downstream", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const requestStartedAt = Date.parse("2035-05-18T03:20:00.000Z")
    const replayExpiresAt = requestStartedAt + 1_000
    const authorizationCodeId = "boundary-authorization-code"
    const originalToken = "boundary-original-refresh-token"
    const successorToken = "boundary-successor-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    vi.useFakeTimers()
    vi.setSystemTime(requestStartedAt)
    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(requestStartedAt - 10_000).toISOString(),
      expiresAt: new Date(requestStartedAt + 60_000).toISOString(),
      id: "boundary-original-refresh",
      revoked: new Date(requestStartedAt - 2_000).toISOString(),
      rotatedAt: new Date(requestStartedAt - 2_000).toISOString(),
      rotationReplayExpiresAt: new Date(replayExpiresAt).toISOString(),
      token: storedToken(originalToken),
      userId,
    })

    const oauthApp = new OpenAPIHono<AppBindings>({ strict: true })
    oauthApp.use("*", requestId)
    oauthApp.use("/api/auth/oauth2/token", enforceOAuthRefreshFamilyRevocation)
    oauthApp.use("/api/auth/oauth2/token", async (context, next) => {
      const auditCapture = await captureOAuthProtocolAudit(context)
      await next()
      scheduleOAuthProtocolAudit(context, auditCapture, context.res)
    })
    oauthApp.post("/api/auth/oauth2/token", async (context) => {
      vi.setSystemTime(replayExpiresAt + 1)
      await insertRefreshToken({
        authorizationCodeId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(requestStartedAt + 60_000).toISOString(),
        id: "boundary-successor-refresh",
        token: storedToken(successorToken),
        userId,
      })
      return context.json(
        {
          error: "invalid_grant",
          error_description: "invalid refresh token",
        },
        400,
      )
    })

    const executionContext = createExecutionContext()
    const response = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/token", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          grant_type: "refresh_token",
          refresh_token: originalToken,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      executionContext,
    )
    await waitOnExecutionContext(executionContext)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "invalid_grant",
      error_description: "invalid refresh token",
    })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1`,
      )
        .bind(authorizationCodeId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'boundary-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM security_audit_events
         WHERE type = 'oauth_refresh_reuse_detected'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 1 })
  })

  it("does not tombstone a successful refresh replay that completes after the retry window", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const requestStartedAt = Date.parse("2035-05-18T03:20:00.000Z")
    const replayExpiresAt = requestStartedAt + 1_000
    const authorizationCodeId = "successful-boundary-authorization-code"
    const originalToken = "successful-boundary-original-refresh-token"
    const successorToken = "successful-boundary-successor-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    vi.useFakeTimers()
    vi.setSystemTime(requestStartedAt)
    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(requestStartedAt - 10_000).toISOString(),
      expiresAt: new Date(requestStartedAt + 60_000).toISOString(),
      id: "successful-boundary-original-refresh",
      revoked: new Date(requestStartedAt - 2_000).toISOString(),
      rotatedAt: new Date(requestStartedAt - 2_000).toISOString(),
      rotationReplayExpiresAt: new Date(replayExpiresAt).toISOString(),
      token: storedToken(originalToken),
      userId,
    })
    await insertRefreshToken({
      authorizationCodeId,
      createdAt: new Date(requestStartedAt - 1_000).toISOString(),
      expiresAt: new Date(requestStartedAt + 60_000).toISOString(),
      id: "successful-boundary-successor-refresh",
      token: storedToken(successorToken),
      userId,
    })

    const oauthApp = new OpenAPIHono<AppBindings>({ strict: true })
    oauthApp.use("/api/auth/oauth2/token", enforceOAuthRefreshFamilyRevocation)
    oauthApp.post("/api/auth/oauth2/token", (context) => {
      vi.setSystemTime(replayExpiresAt + 1)
      return context.json({
        access_token: "synthetic-access-token",
        refresh_token: successorToken,
        token_type: "Bearer",
      })
    })

    const response = await oauthApp.fetch(
      new Request("http://local.test/api/auth/oauth2/token", {
        body: new URLSearchParams({
          client_id: "eruoo-desktop",
          grant_type: "refresh_token",
          refresh_token: originalToken,
        }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    )

    expect(response.status).toBe(200)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1`,
      )
        .bind(authorizationCodeId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        `SELECT revoked
         FROM oauthRefreshToken
         WHERE id = 'successful-boundary-successor-refresh'`,
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: null })
  })

  it("treats the token type hint as advisory without crossing client boundaries", async () => {
    await createOwnerSession()
    const userId = await currentOwnerId()
    const now = Date.now()
    const hintedAuthorizationCodeId = "hint-authorization-code"
    const hintedRawToken = "hint-refresh-token"
    const otherClientAuthorizationCodeId = "other-client-authorization-code"
    const otherClientRawToken = "other-client-refresh-token"
    const storedToken = (value: string) =>
      createHash("sha256").update(value).digest("base64url")

    await insertRefreshToken({
      authorizationCodeId: hintedAuthorizationCodeId,
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "hint-refresh",
      token: storedToken(hintedRawToken),
      userId,
    })
    await insertRefreshToken({
      authorizationCodeId: otherClientAuthorizationCodeId,
      createdAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      id: "other-client-refresh",
      token: storedToken(otherClientRawToken),
      userId,
    })

    let downstreamCalls = 0
    const revokeApp = new OpenAPIHono<AppBindings>({ strict: true })
    revokeApp.use(
      "/api/auth/oauth2/revoke",
      enforceOAuthRefreshFamilyRevocation,
    )
    revokeApp.post("/api/auth/oauth2/revoke", (context) => {
      downstreamCalls += 1
      return context.body(null, 200)
    })

    const requestRevoke = (
      clientId: string,
      rawToken: string,
      tokenTypeHint: string,
    ) =>
      revokeApp.fetch(
        new Request("http://local.test/api/auth/oauth2/revoke", {
          body: new URLSearchParams({
            client_id: clientId,
            token: rawToken,
            token_type_hint: tokenTypeHint,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
        }),
        env,
        createExecutionContext(),
      )

    expect(
      (await requestRevoke("eruoo-desktop", hintedRawToken, "access_token"))
        .status,
    ).toBe(200)
    expect(
      (
        await requestRevoke(
          "another-client",
          otherClientRawToken,
          "refresh_token",
        )
      ).status,
    ).toBe(200)
    expect(downstreamCalls).toBe(2)
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1`,
      )
        .bind(hintedAuthorizationCodeId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 })
    expect(
      await env.DB.prepare(
        "SELECT revoked FROM oauthRefreshToken WHERE id = 'hint-refresh'",
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: expect.any(String) })
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM oauthRefreshTokenFamilyRevocation
         WHERE authorizationCodeId = ?1`,
      )
        .bind(otherClientAuthorizationCodeId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 })
    expect(
      await env.DB.prepare(
        "SELECT revoked FROM oauthRefreshToken WHERE id = 'other-client-refresh'",
      ).first<{ revoked: string | null }>(),
    ).toEqual({ revoked: null })
  })

  it("rejects revocation from a stale owner Session before mutation", async () => {
    const cookie = await createOwnerSession({
      reauthenticatedAt: new Date(Date.now() - 16 * 60 * 1000),
    })
    const userId = await currentOwnerId()
    await insertConsent({ id: "preserved-consent", userId })

    const response = await fetchAuthorization(
      "/api/oauth/authorizations/eruoo-desktop",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
        method: "DELETE",
      },
    )
    const stored = await env.DB.prepare(
      "SELECT id FROM oauthConsent WHERE id = 'preserved-consent'",
    ).first()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/recent-authentication-required",
    })
    expect(stored).not.toBeNull()
  })

  it("fails closed before revocation when the client registry is not static", async () => {
    const cookie = await createOwnerSession()
    const userId = await currentOwnerId()
    await insertConsent({ id: "preserved-consent", userId })
    await env.DB.prepare(
      `INSERT INTO oauthClient (id, clientId, disabled, redirectUris)
       VALUES (?1, ?2, 0, '[]')`,
    )
      .bind("unknown-client-row", "unknown-client")
      .run()

    const response = await fetchAuthorization(
      "/api/oauth/authorizations/eruoo-desktop",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
        method: "DELETE",
      },
    )
    const stored = await env.DB.prepare(
      "SELECT id FROM oauthConsent WHERE id = 'preserved-consent'",
    ).first()

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/service-unavailable",
    })
    expect(stored).not.toBeNull()
  })

  it.each([
    {
      clientId: "eruoo-web",
      expectedStatus: 403,
      expectedType: "permission-denied",
      name: "Web",
    },
    {
      clientId: "unknown-client",
      expectedStatus: 404,
      expectedType: "not-found",
      name: "an unknown client",
    },
    {
      clientId: "eruoo-desktop",
      expectedStatus: 404,
      expectedType: "not-found",
      name: "a client without an authorization",
    },
  ])(
    "rejects revocation for $name",
    async ({ clientId, expectedStatus, expectedType }) => {
      const cookie = await createOwnerSession()
      const response = await fetchAuthorization(
        `/api/oauth/authorizations/${clientId}`,
        {
          headers: { cookie: `eruoo.session_token=${cookie}` },
          method: "DELETE",
        },
      )

      expect(response.status).toBe(expectedStatus)
      expect(await response.json()).toMatchObject({
        type: `https://auth.eruoo.me/problems/${expectedType}`,
      })
    },
  )
})

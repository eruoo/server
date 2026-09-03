import { createHash } from "node:crypto"

import { betterAuth } from "better-auth"
import { env, SELF } from "cloudflare:test"
import { Hono } from "hono"
import { decodeJwt, decodeProtectedHeader } from "jose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import { createAuthOptions } from "../../src/worker/auth"
import { createRequireOAuthPrincipal } from "../../src/worker/auth/oauth-principal"
import { cleanupExpiredOAuthTokenState } from "../../src/worker/auth/oauth-token-cleanup"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { createOwnerSession } from "./fixtures/owner-session"

const applicationOrigin = "http://localhost:5173"
const clientId = "eruoo-desktop"
const redirectUri = "http://127.0.0.1:49152/oauth/callback"
const scope = "openid profile api:read api:write offline_access"
const userInfoAudience = `${applicationOrigin}/api/auth/oauth2/userinfo`

interface AuthorizationCodeGrant {
  code: string
  cookie: string
  nonce: string
  state: string
  userId: string
  verifier: string
}

interface IssuedGrant extends AuthorizationCodeGrant {
  tokens: OAuthTokenResponse
}

interface OAuthTokenResponse {
  access_token: string
  expires_at: number
  expires_in: number
  id_token?: string
  refresh_token: string
  scope: string
  token_type: string
}

interface StoredRefreshToken {
  authorizationCodeId: string
  clientId: string
  expiresAt: string | number
  id: string
  resources: string
  revoked: string | number | null
  rotatedAt: string | number | null
  rotationReplayExpiresAt: string | number | null
  scopes: string
  token: string
}

type OAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

const workerFetch: OAuthFetch = (input, init) => SELF.fetch(input, init)

const businessFixture = new Hono<AppBindings>({ strict: true })
businessFixture.use("*", requestId)
businessFixture.use("/api/fixture", createRequireOAuthPrincipal(["api:read"]))
businessFixture.get("/api/fixture", (context) =>
  context.json(context.var.principal),
)

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url")
}

function storedTokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  )
}

async function authorize(
  options?: {
    resource?: string
    scope?: string
    session?: { cookie: string; userId: string }
  },
  fetcher: OAuthFetch = workerFetch,
): Promise<AuthorizationCodeGrant> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const cookie = options?.session?.cookie ?? (await createOwnerSession())
  const userId = options?.session?.userId
  const owner = userId
    ? { id: userId }
    : await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
        id: string
      }>()
  if (!owner) throw new Error("The synthetic owner was not created.")

  const authorizeUrl = new URL("http://local.test/api/auth/oauth2/authorize")
  authorizeUrl.searchParams.set("client_id", clientId)
  authorizeUrl.searchParams.set("code_challenge", await pkceChallenge(verifier))
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set("nonce", nonce)
  authorizeUrl.searchParams.set("redirect_uri", redirectUri)
  authorizeUrl.searchParams.set("resource", options?.resource ?? OAUTH_RESOURCE)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set("scope", options?.scope ?? scope)
  authorizeUrl.searchParams.set("state", state)

  const authorization = await fetcher(authorizeUrl, {
    headers: {
      "cf-connecting-ip": "192.0.2.20",
      cookie: `eruoo.session_token=${cookie}`,
    },
    redirect: "manual",
  })

  expect(authorization.status).toBe(302)
  const callback = new URL(authorization.headers.get("location") ?? "")
  expect(callback.origin + callback.pathname).toBe(
    "http://127.0.0.1:49152/oauth/callback",
  )
  expect(callback.searchParams.get("state")).toBe(state)
  expect(callback.searchParams.get("iss")).toBe(applicationOrigin)
  const code = callback.searchParams.get("code")
  expect(code).toBeTruthy()

  return { code: code!, cookie, nonce, state, userId: owner.id, verifier }
}

async function exchangeAuthorizationCode(
  grant: AuthorizationCodeGrant,
  options?: {
    codeVerifier?: string
    includeResource?: boolean
    resource?: string
  },
  fetcher: OAuthFetch = workerFetch,
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: clientId,
    code: grant.code,
    code_verifier: options?.codeVerifier ?? grant.verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  })
  if (options?.includeResource !== false) {
    body.set("resource", options?.resource ?? OAUTH_RESOURCE)
  }

  return fetcher("http://local.test/api/auth/oauth2/token", {
    body,
    headers: {
      "cf-connecting-ip": "192.0.2.20",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  })
}

async function issueTokens(
  fetcher: OAuthFetch = workerFetch,
): Promise<IssuedGrant> {
  const grant = await authorize(undefined, fetcher)
  const response = await exchangeAuthorizationCode(grant, undefined, fetcher)
  expect(response.status).toBe(200)
  return { ...grant, tokens: await response.json<OAuthTokenResponse>() }
}

function refreshRequest(
  refreshToken: string,
  options?: { resource?: string; scope?: string },
  fetcher: OAuthFetch = workerFetch,
): Promise<Response> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  })
  if (options?.resource) body.set("resource", options.resource)
  if (options?.scope) body.set("scope", options.scope)

  return fetcher("http://local.test/api/auth/oauth2/token", {
    body,
    headers: {
      "cf-connecting-ip": "192.0.2.20",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  })
}

function revokeRefreshToken(
  refreshToken: string,
  tokenTypeHint = "refresh_token",
): Promise<Response> {
  return SELF.fetch("http://local.test/api/auth/oauth2/revoke", {
    body: new URLSearchParams({
      client_id: clientId,
      token: refreshToken,
      token_type_hint: tokenTypeHint,
    }),
    headers: {
      "cf-connecting-ip": "192.0.2.20",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  })
}

function installLocalJwksFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request =
        input instanceof Request && init === undefined
          ? input.clone()
          : new Request(input, init)
      const url = new URL(request.url)

      if (
        request.method === "GET" &&
        url.origin === applicationOrigin &&
        url.pathname === "/api/auth/jwks"
      ) {
        return SELF.fetch(`http://local.test${url.pathname}${url.search}`, {
          headers: request.headers,
        })
      }

      throw new Error(`Unexpected outbound request: ${request.method} ${url}`)
    })
}

async function findStoredRefreshToken(
  rawToken: string,
): Promise<StoredRefreshToken | null> {
  return env.DB.prepare(
    `SELECT id, token, clientId, resources, scopes, expiresAt, revoked,
            rotatedAt, rotationReplayExpiresAt, authorizationCodeId
     FROM oauthRefreshToken
     WHERE token = ?1
     LIMIT 1`,
  )
    .bind(storedTokenHash(rawToken))
    .first<StoredRefreshToken>()
}

async function cleanOAuthFlowState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE oauthResource
         SET signingAlgorithm = 'EdDSA'
         WHERE identifier = ?1`,
    ).bind(OAUTH_RESOURCE),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM oauthAccessToken"),
    env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
    env.DB.prepare("DELETE FROM oauthRefreshToken"),
    env.DB.prepare("DELETE FROM oauthConsent"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM jwks"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
}

beforeEach(cleanOAuthFlowState)
afterEach(cleanOAuthFlowState)

describe("Better Auth OAuth provider flow", () => {
  it("accepts UserInfo access tokens only in the Authorization header", async () => {
    const { tokens, userId } = await issueTokens()
    const endpoint = "http://local.test/api/auth/oauth2/userinfo"
    const invalidRequestBody = {
      error: "invalid_request",
      error_description:
        "access_token must be provided only in the Authorization header",
    }
    const invalidRequestChallenge =
      'Bearer realm="eruoo-api", error="invalid_request"'
    const queryEndpoint = new URL(endpoint)
    queryEndpoint.searchParams.set("access_token", tokens.access_token)
    const invalidRequests = [
      new Request(endpoint, {
        body: new URLSearchParams({ access_token: tokens.access_token }),
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      new Request(endpoint, {
        body: `access_token=${encodeURIComponent(tokens.access_token)}&ignored=%ZZ`,
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      new Request(endpoint, {
        body: JSON.stringify({ access_token: tokens.access_token }),
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/json",
        },
        method: "POST",
      }),
      new Request(queryEndpoint, {
        headers: { "cf-connecting-ip": "192.0.2.20" },
      }),
      new Request(endpoint, {
        body: new URLSearchParams({ access_token: tokens.access_token }),
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
    ]

    for (const request of invalidRequests) {
      const response = await SELF.fetch(request)

      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("www-authenticate")).toBe(
        invalidRequestChallenge,
      )
      await expect(response.json()).resolves.toEqual(invalidRequestBody)
    }

    const accepted = await SELF.fetch(endpoint, {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "cf-connecting-ip": "192.0.2.20",
      },
    })

    expect(accepted.status).toBe(200)
    expect(accepted.headers.get("cache-control")).toBe("no-store")
    expect(accepted.headers.get("www-authenticate")).toBeNull()
    await expect(accepted.json()).resolves.toMatchObject({ sub: userId })
  })

  it("issues a real RFC 9068 EdDSA token and accepts it at a business route", async () => {
    const { nonce, tokens, userId } = await issueTokens()
    const header = decodeProtectedHeader(tokens.access_token)
    const claims = decodeJwt(tokens.access_token)

    expect(header).toMatchObject({ alg: "EdDSA", typ: "at+jwt" })
    expect(header.kid).toMatch(/\S+/)
    expect(claims).toMatchObject({
      aud: [OAUTH_RESOURCE, userInfoAudience],
      client_id: clientId,
      iss: applicationOrigin,
      scope,
      sub: userId,
    })
    expect(claims.exp! - claims.iat!).toBe(3_600)
    expect(tokens.id_token).toEqual(expect.any(String))
    expect(tokens.refresh_token).toEqual(expect.any(String))
    expect(tokens.scope).toBe(scope)
    expect(tokens.token_type).toBe("Bearer")
    expect(decodeJwt(tokens.id_token!)).toMatchObject({
      aud: clientId,
      iss: applicationOrigin,
      nonce,
      sub: userId,
    })
    expect(decodeJwt(tokens.id_token!)["sid"]).toEqual(expect.any(String))

    const response = await businessFixture.fetch(
      new Request("http://local.test/api/fixture", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      env,
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      authMethod: "oauth",
      clientId,
      scopes: scope.split(" "),
      subject: userId,
    })

    const storedRefresh = await findStoredRefreshToken(tokens.refresh_token)
    expect(storedRefresh).toMatchObject({
      authorizationCodeId: expect.stringMatching(/\S+/),
      clientId,
      resources: JSON.stringify([OAUTH_RESOURCE]),
      revoked: null,
      scopes: JSON.stringify(scope.split(" ")),
    })
    expect(storedRefresh?.token).toBe(storedTokenHash(tokens.refresh_token))
    expect(storedRefresh?.token).not.toBe(tokens.refresh_token)

    const audit = await env.DB.prepare(
      `SELECT clientId, metadata, outcome, type
       FROM security_audit_events
       WHERE type = 'oauth_grant_created'
       LIMIT 1`,
    ).first<{
      clientId: string
      metadata: string
      outcome: string
      type: string
    }>()
    expect(audit).toMatchObject({
      clientId,
      outcome: "success",
      type: "oauth_grant_created",
    })
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
      flow: "authorization_code",
    })
    expect(JSON.stringify(audit)).not.toContain(tokens.access_token)
    expect(JSON.stringify(audit)).not.toContain(tokens.refresh_token)
  })

  it("issues and refreshes real RS256 tokens under an isolated server-side conformance policy", async () => {
    const auth = betterAuth(
      createAuthOptions(env, env.DB, {
        oauthAccessTokenSigningAlgorithm: "RS256",
      }),
    )
    await auth.$context
    const conformanceFetch: OAuthFetch = (input, init) =>
      auth.handler(new Request(input, init))

    const { tokens, userId } = await issueTokens(conformanceFetch)
    expect(decodeProtectedHeader(tokens.access_token)).toMatchObject({
      alg: "RS256",
      typ: "at+jwt",
    })

    const issuedAccess = await businessFixture.fetch(
      new Request("http://local.test/api/fixture", {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      env,
    )
    expect(issuedAccess.status).toBe(200)
    await expect(issuedAccess.json()).resolves.toMatchObject({
      authMethod: "oauth",
      clientId,
      subject: userId,
    })

    const refreshedResponse = await refreshRequest(
      tokens.refresh_token,
      undefined,
      conformanceFetch,
    )
    expect(refreshedResponse.status).toBe(200)
    const refreshed = await refreshedResponse.json<OAuthTokenResponse>()
    expect(decodeProtectedHeader(refreshed.access_token)).toMatchObject({
      alg: "RS256",
      typ: "at+jwt",
    })

    const refreshedAccess = await businessFixture.fetch(
      new Request("http://local.test/api/fixture", {
        headers: { authorization: `Bearer ${refreshed.access_token}` },
      }),
      env,
    )
    expect(refreshedAccess.status).toBe(200)
  }, 30_000)

  it("binds the code exchange to PKCE S256 and the exact resource", async () => {
    const missingResourceGrant = await authorize()
    const missingResource = await exchangeAuthorizationCode(
      missingResourceGrant,
      { includeResource: false },
    )
    expect(missingResource.status).toBe(400)
    await expect(missingResource.json()).resolves.toMatchObject({
      error: "invalid_target",
    })

    const recovered = await exchangeAuthorizationCode(missingResourceGrant)
    expect(recovered.status).toBe(200)

    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauthRefreshToken"),
      env.DB.prepare("DELETE FROM verification"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM rateLimit"),
    ])

    const wrongVerifierGrant = await authorize()
    const wrongVerifier = await exchangeAuthorizationCode(wrongVerifierGrant, {
      codeVerifier: base64Url(crypto.getRandomValues(new Uint8Array(48))),
    })
    expect(wrongVerifier.status).toBe(401)
    await expect(wrongVerifier.json()).resolves.toMatchObject({
      error: "invalid_request",
    })
  })

  it("rotates refresh tokens and replays the same successor for an equivalent retry", async () => {
    const { tokens } = await issueTokens()
    const firstResponse = await refreshRequest(tokens.refresh_token)
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json<OAuthTokenResponse>()

    expect(first.refresh_token).not.toBe(tokens.refresh_token)
    expect(decodeJwt(first.access_token).aud).toEqual([
      OAUTH_RESOURCE,
      userInfoAudience,
    ])

    const original = await findStoredRefreshToken(tokens.refresh_token)
    const successor = await findStoredRefreshToken(first.refresh_token)
    expect(original).toMatchObject({
      revoked: expect.any(String),
      rotatedAt: expect.any(String),
      rotationReplayExpiresAt: expect.any(String),
    })
    expect(successor).toMatchObject({ revoked: null })
    expect(successor?.authorizationCodeId).toBe(original?.authorizationCodeId)

    const changedRetry = await refreshRequest(tokens.refresh_token, {
      scope: "api:read offline_access",
    })
    expect(changedRetry.status).toBe(400)
    await expect(changedRetry.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
    expect(
      (await findStoredRefreshToken(first.refresh_token))?.revoked,
    ).toBeNull()

    const retryResponse = await refreshRequest(tokens.refresh_token)
    expect(retryResponse.status).toBe(200)
    const retry = await retryResponse.json<OAuthTokenResponse>()
    expect(retry.access_token).toBe(first.access_token)
    expect(retry.refresh_token).toBe(first.refresh_token)
    expect(retry.expires_at).toBe(first.expires_at)
    expect(retry.expires_in).toBeLessThanOrEqual(first.expires_in)

    const reuseAuditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE type = 'oauth_refresh_reuse_detected'`,
    ).first<{ count: number }>()
    expect(reuseAuditCount?.count).toBe(0)
  })

  it("revokes a rotated refresh-token family idempotently", async () => {
    const { tokens, userId } = await issueTokens()
    const rotatedResponse = await refreshRequest(tokens.refresh_token)
    expect(rotatedResponse.status).toBe(200)
    const successor = await rotatedResponse.json<OAuthTokenResponse>()

    const original = await findStoredRefreshToken(tokens.refresh_token)
    if (!original) throw new Error("The rotated refresh token was not stored.")
    expect(original).toMatchObject({
      authorizationCodeId: expect.stringMatching(/\S+/),
      revoked: expect.any(String),
      rotatedAt: expect.any(String),
    })

    for (const revocation of [
      await revokeRefreshToken(tokens.refresh_token),
      await revokeRefreshToken(tokens.refresh_token),
    ]) {
      expect(revocation.status).toBe(200)
      expect(revocation.headers.get("cache-control")).toBe("no-store")
      await expect(revocation.text()).resolves.toBe("")
    }

    const rejectedSuccessor = await refreshRequest(successor.refresh_token)
    expect(rejectedSuccessor.status).toBe(400)
    await expect(rejectedSuccessor.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })

    const remainingFamily = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM oauthRefreshToken
       WHERE authorizationCodeId = ?1`,
    )
      .bind(original.authorizationCodeId)
      .first<{ count: number }>()
    expect(remainingFamily?.count).toBe(0)

    const tombstone = await env.DB.prepare(
      `SELECT revokedAt
       FROM oauthRefreshTokenFamilyRevocation
       WHERE authorizationCodeId = ?1
         AND clientId = ?2
         AND userId = ?3`,
    )
      .bind(original.authorizationCodeId, clientId, userId)
      .first<{ revokedAt: number }>()
    expect(tombstone?.revokedAt).toEqual(expect.any(Number))

    const revocationAudits = await env.DB.prepare(
      `SELECT clientId, outcome, subjectId, type
       FROM security_audit_events
       WHERE type = 'oauth_grant_revoked'
       ORDER BY occurredAt, id`,
    ).all<{
      clientId: string | null
      outcome: string
      subjectId: string | null
      type: string
    }>()
    expect(revocationAudits.results).toEqual([
      {
        clientId,
        outcome: "success",
        subjectId: userId,
        type: "oauth_grant_revoked",
      },
    ])
  })

  it.each(["active", "rotated"] as const)(
    "audits concurrent revocations of an %s refresh token exactly once",
    async (tokenState) => {
      const { tokens, userId } = await issueTokens()
      if (tokenState === "rotated") {
        const rotation = await refreshRequest(tokens.refresh_token)
        if (rotation.status !== 200) {
          throw new Error("The refresh token could not be rotated.")
        }
      }

      const responses = await Promise.all([
        revokeRefreshToken(tokens.refresh_token),
        revokeRefreshToken(tokens.refresh_token),
      ])

      for (const response of responses) {
        expect(response.status).toBe(200)
        expect(response.headers.get("cache-control")).toBe("no-store")
        await expect(response.text()).resolves.toBe("")
      }

      const audits = await env.DB.prepare(
        `SELECT clientId, outcome, subjectId
         FROM security_audit_events
         WHERE type = 'oauth_grant_revoked'`,
      ).all<{
        clientId: string | null
        outcome: string
        subjectId: string | null
      }>()
      expect(audits.results).toEqual([
        { clientId, outcome: "success", subjectId: userId },
      ])
    },
  )

  it("revokes a refresh token even when its token type hint is incorrect", async () => {
    const { tokens, userId } = await issueTokens()
    const stored = await findStoredRefreshToken(tokens.refresh_token)
    if (!stored) throw new Error("The refresh token was not stored.")

    const revocation = await revokeRefreshToken(
      tokens.refresh_token,
      "access_token",
    )

    expect(revocation.status).toBe(200)
    expect(revocation.headers.get("cache-control")).toBe("no-store")
    await expect(revocation.text()).resolves.toBe("")
    expect(
      (await findStoredRefreshToken(tokens.refresh_token))?.revoked,
    ).not.toBeNull()
    const tombstone = await env.DB.prepare(
      `SELECT revokedAt
       FROM oauthRefreshTokenFamilyRevocation
       WHERE authorizationCodeId = ?1
         AND clientId = ?2
         AND userId = ?3`,
    )
      .bind(stored.authorizationCodeId, clientId, userId)
      .first<{ revokedAt: number }>()
    expect(tombstone?.revokedAt).toEqual(expect.any(Number))

    const rejected = await refreshRequest(tokens.refresh_token)
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
  })

  it("rejects a real OAuth access token on Session-only management routes", async () => {
    const { tokens } = await issueTokens()

    for (const path of [
      "/api/auth/api-key/list",
      "/api/auth/passkey/list-user-passkeys",
    ]) {
      const response = await SELF.fetch(`http://local.test${path}`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      await expect(response.json()).resolves.toMatchObject({
        type: "https://auth.eruoo.me/problems/authentication-required",
      })
    }
  })

  it.each(["access_token", "refresh_token"] as const)(
    "preserves unsupported_token_type for self-contained access tokens with a %s hint",
    async (tokenTypeHint) => {
      const { tokens } = await issueTokens()
      const response = await SELF.fetch(
        "http://local.test/api/auth/oauth2/revoke",
        {
          body: new URLSearchParams({
            client_id: clientId,
            token: tokens.access_token,
            token_type_hint: tokenTypeHint,
          }),
          headers: {
            "cf-connecting-ip": "192.0.2.20",
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        },
      )

      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(response.json()).resolves.toEqual({
        error: "unsupported_token_type",
        error_description:
          "JWT access tokens are self-contained and cannot be revoked server-side",
      })
    },
  )

  it("accepts only the bound resource on refresh without consuming the token on rejection", async () => {
    const { tokens } = await issueTokens()
    const rejected = await refreshRequest(tokens.refresh_token, {
      resource: "https://resource.example.invalid/api",
    })
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({
      error: "invalid_target",
    })

    const accepted = await refreshRequest(tokens.refresh_token, {
      resource: OAUTH_RESOURCE,
    })
    expect(accepted.status).toBe(200)
    const refreshed = await accepted.json<OAuthTokenResponse>()
    expect(decodeJwt(refreshed.access_token).aud).toEqual([
      OAUTH_RESOURCE,
      userInfoAudience,
    ])
  })

  it("allows concurrent refreshes to produce at most one successor chain", async () => {
    const { tokens } = await issueTokens()
    const responses = await Promise.all([
      refreshRequest(tokens.refresh_token),
      refreshRequest(tokens.refresh_token),
    ])
    const results = await Promise.all(
      responses.map(async (response) => ({
        body: (await response.json()) as
          | OAuthTokenResponse
          | {
              error: string
            },
        ok: response.ok,
        status: response.status,
      })),
    )
    const successful = results
      .filter(
        (
          result,
        ): result is typeof result & {
          body: OAuthTokenResponse
          ok: true
        } => result.ok,
      )
      .map(({ body }) => body)
    const rejected = results.filter(({ ok }) => !ok)

    expect(successful.length).toBeGreaterThanOrEqual(1)
    expect(rejected.every(({ status }) => status === 400)).toBe(true)
    expect(rejected.map(({ body }) => body)).toEqual(
      rejected.map(() => expect.objectContaining({ error: "invalid_grant" })),
    )
    expect(
      new Set(
        successful.map(
          ({ access_token, refresh_token }) =>
            `${access_token}\u0000${refresh_token}`,
        ),
      ).size,
    ).toBe(1)

    const rows = await env.DB.prepare(
      `SELECT id, revoked, rotatedAt
       FROM oauthRefreshToken
       ORDER BY createdAt, id`,
    ).all<{ id: string; revoked: string | null; rotatedAt: string | null }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.filter(({ revoked }) => revoked === null)).toHaveLength(
      1,
    )
  })

  it("invalidates the family and audits reuse outside the 30-second retry window", async () => {
    const { cookie, tokens, userId } = await issueTokens()
    const rotated = await refreshRequest(tokens.refresh_token)
    expect(rotated.status).toBe(200)
    const successor = await rotated.json<OAuthTokenResponse>()

    const original = await findStoredRefreshToken(tokens.refresh_token)
    if (!original) throw new Error("The original refresh token was not stored.")
    const replayBeforeCleanup = await env.DB.prepare(
      `SELECT rotationReplayResponse
       FROM oauthRefreshToken
       WHERE id = ?1`,
    )
      .bind(original.id)
      .first<{ rotationReplayResponse: string | null }>()
    expect(replayBeforeCleanup?.rotationReplayResponse).toEqual(
      expect.any(String),
    )

    const cleanupBoundary = Date.now()
    await env.DB.prepare(
      `UPDATE oauthRefreshToken
       SET rotationReplayExpiresAt = ?1
       WHERE id = ?2`,
    )
      .bind(new Date(cleanupBoundary - 1_000).toISOString(), original.id)
      .run()

    const cleanup = await cleanupExpiredOAuthTokenState(env.DB, cleanupBoundary)
    expect(cleanup).toMatchObject({
      clearedReplayResponses: 1,
      deletedRefreshTokens: 0,
    })
    const replayAfterCleanup = await env.DB.prepare(
      `SELECT rotatedAt, rotationReplayExpiresAt, rotationReplayResponse
       FROM oauthRefreshToken
       WHERE id = ?1`,
    )
      .bind(original.id)
      .first<{
        rotatedAt: string | null
        rotationReplayExpiresAt: string | null
        rotationReplayResponse: string | null
      }>()
    expect(replayAfterCleanup).toMatchObject({
      rotatedAt: expect.any(String),
      rotationReplayExpiresAt: expect.any(String),
      rotationReplayResponse: null,
    })

    const independentGrant = await authorize({
      session: { cookie, userId },
    })
    const independentTokenResponse =
      await exchangeAuthorizationCode(independentGrant)
    expect(independentTokenResponse.status).toBe(200)
    const independentTokens =
      await independentTokenResponse.json<OAuthTokenResponse>()
    const independentFamily = await findStoredRefreshToken(
      independentTokens.refresh_token,
    )
    expect(independentFamily?.authorizationCodeId).toEqual(expect.any(String))
    expect(independentFamily?.authorizationCodeId).not.toBe(
      original.authorizationCodeId,
    )

    const replay = await refreshRequest(tokens.refresh_token)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })

    const invalidatedFamily = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM oauthRefreshToken
       WHERE authorizationCodeId = ?1`,
    )
      .bind(original.authorizationCodeId)
      .first<{ count: number }>()
    expect(invalidatedFamily?.count).toBe(0)
    expect(
      await findStoredRefreshToken(independentTokens.refresh_token),
    ).toMatchObject({
      authorizationCodeId: independentFamily?.authorizationCodeId,
      revoked: null,
    })

    const familyTombstone = await env.DB.prepare(
      `SELECT revokedAt
       FROM oauthRefreshTokenFamilyRevocation
       WHERE authorizationCodeId = ?1
         AND clientId = ?2
         AND userId = ?3`,
    )
      .bind(original.authorizationCodeId, clientId, userId)
      .first<{ revokedAt: number }>()
    expect(familyTombstone?.revokedAt).toEqual(expect.any(Number))

    const audit = await env.DB.prepare(
      `SELECT clientId, metadata, outcome, subjectId, type
       FROM security_audit_events
       WHERE type = 'oauth_refresh_reuse_detected'
       LIMIT 1`,
    ).first<{
      clientId: string
      metadata: string
      outcome: string
      subjectId: string
      type: string
    }>()
    expect(audit).toMatchObject({
      clientId,
      outcome: "failure",
      type: "oauth_refresh_reuse_detected",
    })
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
      reason: "outside_retry_window",
    })
    expect(JSON.stringify(audit)).not.toContain(tokens.refresh_token)
    expect(JSON.stringify(audit)).not.toContain(successor.refresh_token)

    const independentRefresh = await refreshRequest(
      independentTokens.refresh_token,
    )
    expect(independentRefresh.status).toBe(200)
  })

  it("rejects refresh after the owner revokes the issued authorization", async () => {
    const { cookie, tokens, userId } = await issueTokens()
    const rotatedResponse = await refreshRequest(tokens.refresh_token)
    expect(rotatedResponse.status).toBe(200)
    const rotated = await rotatedResponse.json<OAuthTokenResponse>()
    const originalFamily = await findStoredRefreshToken(rotated.refresh_token)
    expect(originalFamily?.authorizationCodeId).toEqual(expect.any(String))

    const revoked = await SELF.fetch(
      "http://local.test/api/oauth/authorizations/eruoo-desktop",
      {
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          cookie: `eruoo.session_token=${cookie}`,
          origin: applicationOrigin,
          "sec-fetch-site": "same-origin",
        },
        method: "DELETE",
      },
    )
    expect(revoked.status).toBe(200)
    await expect(revoked.json()).resolves.toMatchObject({
      clientId,
      revokedRefreshTokenCount: 1,
    })

    const rejected = await refreshRequest(rotated.refresh_token)
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })

    const familyRevocations = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM oauthRefreshTokenFamilyRevocation
       WHERE clientId = ?1 AND userId = ?2`,
    )
      .bind(clientId, userId)
      .first<{ count: number }>()
    expect(familyRevocations?.count).toBe(1)

    const newGrant = await authorize({ session: { cookie, userId } })
    const newTokenResponse = await exchangeAuthorizationCode(newGrant)
    expect(newTokenResponse.status).toBe(200)
    const newTokens = await newTokenResponse.json<OAuthTokenResponse>()
    const newFamily = await findStoredRefreshToken(newTokens.refresh_token)
    expect(newFamily?.authorizationCodeId).toEqual(expect.any(String))
    expect(newFamily?.authorizationCodeId).not.toBe(
      originalFamily?.authorizationCodeId,
    )

    const acceptedNewFamily = await refreshRequest(newTokens.refresh_token)
    expect(acceptedNewFamily.status).toBe(200)
  })

  it("does not misclassify an expired rotated token as retry-window reuse", async () => {
    const { tokens } = await issueTokens()
    const rotated = await refreshRequest(tokens.refresh_token)
    expect(rotated.status).toBe(200)

    const original = await findStoredRefreshToken(tokens.refresh_token)
    if (!original) throw new Error("The original refresh token was not stored.")
    const expiredAt = new Date(Date.now() - 1_000).toISOString()
    await env.DB.prepare(
      `UPDATE oauthRefreshToken
       SET expiresAt = ?1, rotationReplayExpiresAt = ?1
       WHERE id = ?2`,
    )
      .bind(expiredAt, original.id)
      .run()

    const rejected = await refreshRequest(tokens.refresh_token)
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM oauthRefreshToken",
    ).first<{ count: number }>()
    expect(remaining?.count).toBe(2)
    const reuseAudit = await env.DB.prepare(
      `SELECT id
       FROM security_audit_events
       WHERE type = 'oauth_refresh_reuse_detected'
       LIMIT 1`,
    ).first()
    expect(reuseAudit).toBeNull()
    const familyRevocations = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM oauthRefreshTokenFamilyRevocation",
    ).first<{ count: number }>()
    expect(familyRevocations?.count).toBe(0)
  })

  it("audits an actual signing-key rotation once for the newly used kid", async () => {
    const { tokens } = await issueTokens()
    const originalKeyId = decodeProtectedHeader(tokens.access_token).kid
    if (!originalKeyId) throw new Error("The original access token has no kid.")

    const beforeRotation = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE type = 'jwt_signing_key_rotated'`,
    ).first<{ count: number }>()
    expect(beforeRotation?.count).toBe(0)

    await env.DB.prepare("UPDATE jwks SET expiresAt = ?1 WHERE id = ?2")
      .bind(new Date(Date.now() - 1_000).toISOString(), originalKeyId)
      .run()

    const refreshedResponse = await refreshRequest(tokens.refresh_token)
    expect(refreshedResponse.status).toBe(200)
    const refreshed = await refreshedResponse.json<OAuthTokenResponse>()
    const rotatedKeyId = decodeProtectedHeader(refreshed.access_token).kid
    expect(rotatedKeyId).toMatch(/\S+/)
    expect(rotatedKeyId).not.toBe(originalKeyId)

    const retry = await refreshRequest(tokens.refresh_token)
    expect(retry.status).toBe(200)
    const retried = await retry.json<OAuthTokenResponse>()
    expect(retried.access_token).toBe(refreshed.access_token)

    const audits = await env.DB.prepare(
      `SELECT clientId, credentialId, metadata, outcome, type
       FROM security_audit_events
       WHERE type = 'jwt_signing_key_rotated'
       ORDER BY occurredAt, id`,
    ).all<{
      clientId: string
      credentialId: string
      metadata: string
      outcome: string
      type: string
    }>()
    expect(audits.results).toEqual([
      {
        clientId,
        credentialId: rotatedKeyId,
        metadata: JSON.stringify({ algorithm: "EdDSA" }),
        outcome: "success",
        type: "jwt_signing_key_rotated",
      },
    ])

    const accepted = await businessFixture.fetch(
      new Request("http://local.test/api/fixture", {
        headers: { authorization: `Bearer ${refreshed.access_token}` },
      }),
      env,
    )
    expect(accepted.status).toBe(200)
  })

  it("combines OIDC logout with refresh-token revocation for native logout", async () => {
    const { cookie, tokens, userId } = await issueTokens()
    if (!tokens.id_token) throw new Error("The OIDC ID token was not issued.")

    const jwksFetch = installLocalJwksFetch()
    try {
      const logoutUrl = new URL("http://local.test/api/auth/oauth2/end-session")
      logoutUrl.searchParams.set("id_token_hint", tokens.id_token)
      const logout = await SELF.fetch(logoutUrl, {
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          cookie: `eruoo.session_token=${cookie}`,
        },
        redirect: "manual",
      })
      expect(logout.status).toBe(200)
    } finally {
      jwksFetch.mockRestore()
    }

    const session = await env.DB.prepare(
      "SELECT id FROM session WHERE userId = ?1 LIMIT 1",
    )
      .bind(userId)
      .first()
    expect(session).toBeNull()

    const afterBrowserLogout = await findStoredRefreshToken(
      tokens.refresh_token,
    )
    if (!afterBrowserLogout) {
      throw new Error(
        "The native refresh token disappeared during OIDC logout.",
      )
    }
    expect(afterBrowserLogout.revoked).toBeNull()

    const revoked = await revokeRefreshToken(tokens.refresh_token)
    expect(revoked.status).toBe(200)
    expect(
      (await findStoredRefreshToken(tokens.refresh_token))?.revoked,
    ).not.toBeNull()
    const logoutFamilyTombstone = await env.DB.prepare(
      `SELECT revokedAt
       FROM oauthRefreshTokenFamilyRevocation
       WHERE authorizationCodeId = ?1
         AND clientId = ?2
         AND userId = ?3`,
    )
      .bind(afterBrowserLogout.authorizationCodeId, clientId, userId)
      .first<{ revokedAt: number }>()
    expect(logoutFamilyTombstone?.revokedAt).toEqual(expect.any(Number))

    const audit = await env.DB.prepare(
      `SELECT clientId, metadata, outcome, subjectId, type
       FROM security_audit_events
       WHERE type = 'oauth_grant_revoked'
       LIMIT 1`,
    ).first<{
      clientId: string
      metadata: string
      outcome: string
      subjectId: string
      type: string
    }>()
    expect(audit).toMatchObject({
      clientId,
      outcome: "success",
      subjectId: userId,
      type: "oauth_grant_revoked",
    })
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
      tokenType: "refresh_token",
    })
    expect(JSON.stringify(audit)).not.toContain(tokens.refresh_token)

    const repeatedRevocation = await revokeRefreshToken(tokens.refresh_token)
    expect(repeatedRevocation.status).toBe(200)

    const rejectedRefresh = await refreshRequest(tokens.refresh_token)
    expect(rejectedRefresh.status).toBe(400)
    await expect(rejectedRefresh.json()).resolves.toMatchObject({
      error: "invalid_grant",
    })
  })

  it("does not issue an authorization code via form POST from a revoked session", async () => {
    const { cookie, userId } = await issueTokens()

    // 建立 30s cookie 缓存：先让 get-session 写入 session_data cookie。
    const sessionRead = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
      },
    )
    expect(sessionRead.status).toBe(200)
    const sessionDataCookie = sessionRead.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .find((value) => value.startsWith("eruoo.session_data="))
    expect(sessionDataCookie).toBeTruthy()

    // 撤销持久化 Session；cookie 缓存仍在 30s 窗口内。
    await env.DB.prepare("DELETE FROM session").run()

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const body = new URLSearchParams({
      client_id: clientId,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      nonce,
      redirect_uri: redirectUri,
      resource: OAUTH_RESOURCE,
      response_type: "code",
      scope,
      state,
    })

    const authorization = await SELF.fetch(
      "http://local.test/api/auth/oauth2/authorize",
      {
        body,
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `eruoo.session_token=${cookie}; ${sessionDataCookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
        redirect: "manual",
      },
    )

    expect(authorization.status).toBe(302)
    const location = new URL(
      authorization.headers.get("location") ?? "",
      "http://local.test",
    )
    expect(location.origin + location.pathname).toMatch(/\/login$/)
    expect(location.searchParams.get("code")).toBeNull()

    const auditRows = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE subjectId = ?1`,
    )
      .bind(userId)
      .first<{ count: number }>()
    expect(auditRows?.count).toBe(0)
  })

  it("does not issue an authorization code when the cookie name carries OWS around '='", async () => {
    const { cookie } = await issueTokens()

    // 建立 30s cookie 缓存：先让 get-session 写入 session_data cookie。
    const sessionRead = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
      },
    )
    const sessionDataCookie = sessionRead.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .find((value) => value.startsWith("eruoo.session_data="))
    expect(sessionDataCookie).toBeTruthy()

    await env.DB.prepare("DELETE FROM session").run()

    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)))
    const body = new URLSearchParams({
      client_id: clientId,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      nonce,
      redirect_uri: redirectUri,
      resource: OAUTH_RESOURCE,
      response_type: "code",
      scope,
      state,
    })

    // RFC 6265 允许 `=` 两侧空白；Better Auth 的 parseCookies 对名字执行
    // trimOWS。权威预检的 cookie 名提取必须同样 trim，否则
    // `eruoo.session_token = <value>` 会被当作未知 cookie 而绕过预检。
    const authorization = await SELF.fetch(
      "http://local.test/api/auth/oauth2/authorize",
      {
        body,
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `eruoo.session_token = ${cookie}; ${sessionDataCookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
        redirect: "manual",
      },
    )

    expect(authorization.status).toBe(302)
    const location = new URL(
      authorization.headers.get("location") ?? "",
      "http://local.test",
    )
    expect(location.origin + location.pathname).toMatch(/\/login$/)
    expect(location.searchParams.get("code")).toBeNull()
    expect(authorization.headers.getSetCookie().length).toBeGreaterThan(0)
  })

  it("clears the cached session cookies in the browser when the authoritative read rejects them", async () => {
    const { cookie } = await issueTokens()

    const sessionRead = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      {
        headers: { cookie: `eruoo.session_token=${cookie}` },
      },
    )
    const sessionDataCookie = sessionRead.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .find((value) => value.startsWith("eruoo.session_data="))
    expect(sessionDataCookie).toBeTruthy()

    await env.DB.prepare("DELETE FROM session").run()

    const body = new URLSearchParams({
      client_id: clientId,
      code_challenge: await pkceChallenge(
        base64Url(crypto.getRandomValues(new Uint8Array(48))),
      ),
      code_challenge_method: "S256",
      nonce: base64Url(crypto.getRandomValues(new Uint8Array(32))),
      redirect_uri: redirectUri,
      resource: OAUTH_RESOURCE,
      response_type: "code",
      scope,
      state: base64Url(crypto.getRandomValues(new Uint8Array(32))),
    })

    const authorization = await SELF.fetch(
      "http://local.test/api/auth/oauth2/authorize",
      {
        body,
        headers: {
          "cf-connecting-ip": "192.0.2.20",
          "content-type": "application/x-www-form-urlencoded",
          cookie: `eruoo.session_token=${cookie}; ${sessionDataCookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
        redirect: "manual",
      },
    )

    expect(authorization.status).toBe(302)
    expect(authorization.headers.getSetCookie().length).toBeGreaterThan(0)
  })
})

import { env } from "cloudflare:test"
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
} from "jose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import { assertStaticOAuthRegistrations } from "../../src/shared/oauth-registration"
import { oauthFetch, origin, storedTokenHash } from "./fixtures/oauth"
import { instrumentDatabase, ownerSession } from "./fixtures/session"

const callback = "https://hako.eruoo.me/api/auth/callback"
let originalClients: Record<string, unknown>[]
let originalLinks: Record<string, unknown>[]
beforeEach(async () => {
  originalClients = (
    await env.DB.prepare("SELECT * FROM oauthClient").all<
      Record<string, unknown>
    >()
  ).results
  originalLinks = (
    await env.DB.prepare("SELECT * FROM oauthClientResource").all<
      Record<string, unknown>
    >()
  ).results
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM jwks WHERE id LIKE 'client-policy-%'"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})
afterEach(async () => {
  vi.restoreAllMocks()
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM oauthClientResource"),
    env.DB.prepare("DELETE FROM oauthClient"),
    ...originalClients.map((row) =>
      env.DB.prepare(
        `INSERT INTO oauthClient (${Object.keys(row).join(",")}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      ).bind(...Object.values(row)),
    ),
    ...originalLinks.map((row) =>
      env.DB.prepare(
        `INSERT INTO oauthClientResource (${Object.keys(row).join(",")}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      ).bind(...Object.values(row)),
    ),
  ])
})

function authorizationQuery(overrides: Record<string, string> = {}) {
  const verifier = crypto.randomUUID().repeat(2)
  const query = new URLSearchParams({
    client_id: "hako-web",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid profile",
    resource: OAUTH_RESOURCE,
    state: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
    code_challenge_method: "S256",
    code_challenge: storedTokenHash(verifier),
    ...overrides,
  })
  return { query, verifier }
}

async function authorize(query: URLSearchParams, cookie?: string) {
  return oauthFetch(`/api/auth/oauth2/authorize?${query}`, {
    headers: cookie ? { cookie } : {},
  })
}

async function exchange(
  code: string,
  verifier: string,
  overrides: Record<string, string> = {},
) {
  return oauthFetch("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "hako-web",
      redirect_uri: callback,
      resource: OAUTH_RESOURCE,
      code,
      code_verifier: verifier,
      ...overrides,
    }),
  })
}

async function issueHakoTokens(cookie: string) {
  const { query, verifier } = authorizationQuery()
  const response = await authorize(query, cookie)
  expect(response.status).toBe(302)
  const target = new URL(response.headers.get("location")!)
  expect(target.origin + target.pathname).toBe(callback)
  expect(target.searchParams.get("state")).toBe(query.get("state"))
  expect(target.searchParams.get("iss")).toBe(origin)
  const code = target.searchParams.get("code")!
  expect(code).toBeTruthy()
  const token = await exchange(code, verifier)
  expect(token.status).toBe(200)
  return {
    query,
    code,
    verifier,
    body: await token.json<{
      access_token: string
      id_token: string
      refresh_token?: string
      scope: string
    }>(),
  }
}

describe("static OAuth client policies", () => {
  it("keeps all migrated registrations and resource links equal to the policy", async () => {
    expect(() =>
      assertStaticOAuthRegistrations(originalClients, originalLinks),
    ).not.toThrow()
  })

  it("issues Hako OIDC tokens and UserInfo without refresh tokens or consent state", async () => {
    const session = await ownerSession()
    const { body, query, code, verifier } = await issueHakoTokens(
      session.cookie,
    )
    expect(body.scope).toBe("openid profile")
    expect(body.refresh_token).toBeUndefined()
    const jwks = await (
      await oauthFetch("/api/auth/jwks")
    ).json<Parameters<typeof createLocalJWKSet>[0]>()
    const { payload } = await jwtVerify(
      body.id_token,
      createLocalJWKSet(jwks),
      { issuer: origin, audience: "hako-web" },
    )
    expect(payload.sub).toBe(session.id)
    expect(payload.nonce).toBe(query.get("nonce"))
    const userinfo = await oauthFetch("/api/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    })
    expect(userinfo.status).toBe(200)
    expect(await userinfo.json()).toMatchObject({
      sub: payload.sub,
      name: "Owner",
    })
    expect(
      (
        await env.DB.prepare(
          "SELECT id FROM oauthRefreshToken WHERE clientId='hako-web'",
        ).all()
      ).results,
    ).toEqual([])
    expect(
      (
        await env.DB.prepare(
          "SELECT id FROM oauthConsent WHERE clientId='hako-web'",
        ).all()
      ).results,
    ).toEqual([])
    expect((await exchange(code, verifier)).status).toBe(400)
    const audits = (
      await env.DB.prepare(
        "SELECT clientId, subjectId FROM security_audit_events WHERE type='oauth_grant_created'",
      ).all()
    ).results
    expect(audits).toEqual([{ clientId: "hako-web", subjectId: session.id }])
    const list = await (
      await oauthFetch("/api/oauth/authorizations", {
        headers: { cookie: session.cookie },
      })
    ).json<Array<Record<string, unknown>>>()
    expect(
      list.find((client) => client["clientId"] === "hako-web"),
    ).toMatchObject({
      enabled: true,
      authorized: false,
      supportsOfflineAccess: false,
      activeRefreshTokenCount: 0,
    })
    const revoke = await oauthFetch("/api/oauth/authorizations/hako-web", {
      method: "DELETE",
      headers: { cookie: session.cookie, origin },
    })
    expect(revoke.status).toBe(403)
  })

  it.each(["api:read", "api:write", "offline_access"])(
    "rejects Hako scope escalation: %s",
    async (scope) => {
      const { query } = authorizationQuery({ scope: `openid profile ${scope}` })
      const response = await authorize(query)
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("invalid_scope")
      const token = await exchange("unused-code", "v".repeat(64), {
        scope: `openid ${scope}`,
      })
      expect(await token.json()).toMatchObject({ error: "invalid_scope" })
    },
  )

  it("denies Hako refresh explicitly even when the library accepts code clients for that grant", async () => {
    const response = await exchange("unused", "unused", {
      grant_type: "refresh_token",
      refresh_token: "unused",
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "unauthorized_client",
    })
  })

  it.each([
    ["code_verifier", "wrong-verifier".repeat(5), 401],
    ["client_id", "eruoo-desktop", 400],
    ["redirect_uri", "https://hako.eruoo.me/other", 400],
  ] as const)(
    "binds the authorization code to PKCE, client and callback: %j",
    async (field, value, status) => {
      const session = await ownerSession()
      const { query, verifier } = authorizationQuery()
      const authorized = await authorize(query, session.cookie)
      const code = new URL(
        authorized.headers.get("location")!,
      ).searchParams.get("code")!
      const response = await exchange(code, verifier, { [field]: value })
      expect(response.status).toBe(status)
      expect((await response.json<{ error: string }>()).error).toMatch(
        /invalid_(grant|request)/,
      )
    },
  )

  it.each([false, true])(
    "refuses Hako end-session without removing the owner's session (drift=%s)",
    async (drift) => {
      const session = await ownerSession()
      const { body } = await issueHakoTokens(session.cookie)
      if (drift)
        await env.DB.prepare(
          "UPDATE oauthClient SET enableEndSession=1 WHERE clientId='hako-web'",
        ).run()
      const response = await oauthFetch(
        `/api/auth/oauth2/end-session?${new URLSearchParams({ client_id: "hako-web", id_token_hint: body.id_token })}`,
        { headers: { cookie: session.cookie } },
      )
      expect(response.status).toBe(drift ? 503 : 401)
      const hintOnly = await oauthFetch(
        `/api/auth/oauth2/end-session?${new URLSearchParams({ id_token_hint: body.id_token })}`,
        { headers: { cookie: session.cookie } },
      )
      expect(hintOnly.status).toBe(drift ? 503 : 401)
      expect(
        await env.DB.prepare("SELECT id FROM session WHERE id=?")
          .bind(session.id)
          .first(),
      ).not.toBeNull()
    },
  )

  it.each([
    "https://hako.eruoo.me/api/auth/callback/",
    "https://hako.eruoo.me:443/api/auth/callback",
    "https://hako.eruoo.me/api/auth/%63allback",
    "https://hako.eruoo.me/api/auth/callback?next=evil",
    "https://hako.eruoo.me.evil.invalid/api/auth/callback",
    "http://127.0.0.1:49152/api/auth/callback",
  ])("rejects a non-exact Hako callback: %s", async (redirect_uri) => {
    const response = await authorize(authorizationQuery({ redirect_uri }).query)
    expect(response.status).toBe(400)
    expect(response.headers.has("location")).toBe(false)
  })

  it.each(["plain", ""])("requires S256 PKCE: %s", async (method) => {
    const { query } = authorizationQuery({ code_challenge_method: method })
    const response = await authorize(query)
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("invalid_request")
  })

  it.each(["https://other.invalid/api", ""])(
    "rejects an unsupported or missing resource: %s",
    async (resource) => {
      const { query } = authorizationQuery({ resource })
      if (!resource) query.delete("resource")
      const response = await authorize(query)
      expect(
        new URL(response.headers.get("location")!).searchParams.get("error"),
      ).toBe("invalid_target")
    },
  )

  it.each([
    ["scopes", '["openid","profile","offline_access"]'],
    ["grantTypes", '["authorization_code","refresh_token"]'],
    ["applicationType", "native"],
    ["skipConsent", 0],
    ["enableEndSession", 1],
    ["requirePKCE", 0],
    ["subjectType", "pairwise"],
    ["disabled", 1],
    ["tokenEndpointAuthMethod", "client_secret_post"],
    ["clientSecret", "unexpected"],
    ["dpopBoundAccessTokens", 1],
    ["responseTypes", '["token"]'],
  ])("fails closed on registration drift in %s", async (field, value) => {
    const session = await ownerSession()
    const { body } = await issueHakoTokens(session.cookie)
    await env.DB.prepare(
      `UPDATE oauthClient SET ${field}=? WHERE clientId='hako-web'`,
    )
      .bind(value)
      .run()
    const response = await authorize(authorizationQuery().query, session.cookie)
    expect(
      new URL(response.headers.get("location")!).searchParams.get("error"),
    ).toBe("temporarily_unavailable")
    expect((await exchange("unused", "unused")).status).toBe(503)
    expect(
      (
        await oauthFetch("/api/auth/oauth2/userinfo", {
          headers: { authorization: `Bearer ${body.access_token}` },
        })
      ).status,
    ).toBe(503)
  })

  it("checks resource registration and owner association on use", async () => {
    const session = await ownerSession()
    const { body } = await issueHakoTokens(session.cookie)
    await env.DB.prepare("DELETE FROM account WHERE userId=?")
      .bind(session.id)
      .run()
    expect(
      (
        await oauthFetch("/api/auth/oauth2/userinfo", {
          headers: { authorization: `Bearer ${body.access_token}` },
        })
      ).status,
    ).toBe(401)
    await env.DB.prepare(
      "DELETE FROM oauthClientResource WHERE clientId='hako-web'",
    ).run()
    expect((await exchange("unused", "unused")).status).toBe(503)
  })

  it.each([
    ["rogue", "openid profile", 401],
    ["eruoo-mobile", "openid profile", 401],
    ["hako-web", "openid profile api:read", 401],
    ["hako-web", "openid profile", 200],
  ] as const)(
    "applies policy to verified UserInfo claims: %s %s",
    async (clientId, scope, status) => {
      const owner = await ownerSession()
      const keys = await generateKeyPair("EdDSA", { crv: "Ed25519" })
      const kid = `client-policy-${crypto.randomUUID()}`
      await env.DB.prepare(
        "INSERT INTO jwks(id,publicKey,privateKey,createdAt,alg,crv) VALUES (?,?,?,?,'EdDSA','Ed25519')",
      )
        .bind(
          kid,
          JSON.stringify(await exportJWK(keys.publicKey)),
          "synthetic-unused-private-key",
          new Date().toISOString(),
        )
        .run()
      const token = await new SignJWT({
        scope,
        client_id: clientId,
        azp: clientId,
        sid: owner.id,
      })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid })
        .setSubject(owner.id)
        .setIssuer(origin)
        .setAudience([OAUTH_RESOURCE, `${origin}/api/auth/oauth2/userinfo`])
        .setIssuedAt()
        .setExpirationTime("1h")
        .setJti(crypto.randomUUID())
        .sign(keys.privateKey)
      // Fresh key-resolver identity: key-refresh cooldown is tested separately.
      const response = await oauthFetch(
        "/api/auth/oauth2/userinfo",
        {
          headers: { authorization: `Bearer ${token}` },
        },
        instrumentDatabase(env.DB, () => {}),
      )
      expect(response.status).toBe(status)
    },
  )

  it("ignores unknown stored clients in the owner list and never admits them", async () => {
    await env.DB.prepare(
      "INSERT INTO oauthClient(id,clientId,disabled,redirectUris,scopes,tokenEndpointAuthMethod) VALUES ('rogue','rogue',0,?,?,'none')",
    )
      .bind(JSON.stringify([callback]), '["openid","profile"]')
      .run()
    const response = await authorize(
      authorizationQuery({ client_id: "rogue" }).query,
    )
    expect(await response.json()).toMatchObject({ error: "invalid_client" })
    expect(
      await (await exchange("unused", "unused", { client_id: "rogue" })).json(),
    ).toMatchObject({ error: "invalid_client" })
    const session = await ownerSession()
    const list = await oauthFetch("/api/oauth/authorizations", {
      headers: { cookie: session.cookie },
    })
    expect(list.status).toBe(200)
    expect(await list.text()).not.toContain("rogue")
  })

  it.each(["consent", "continue"])(
    "audits the real client after /%s",
    async (operation) => {
      const session = await ownerSession()
      const { query } = authorizationQuery(
        operation === "consent" ? { prompt: "consent" } : {},
      )
      const pending = await authorize(
        query,
        operation === "consent" ? session.cookie : undefined,
      )
      const signed = new URL(
        pending.headers.get("location")!,
        origin,
      ).search.slice(1)
      const response = await oauthFetch(`/api/auth/oauth2/${operation}`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          oauth_query: signed,
          ...(operation === "consent" ? { accept: true } : { selected: true }),
        }),
      })
      expect(response.status).toBe(200)
      const result = await response.json<{ url: string }>()
      expect(new URL(result.url).searchParams.get("code")).toBeTruthy()
      expect(
        (
          await env.DB.prepare(
            "SELECT clientId, subjectId FROM security_audit_events WHERE type='oauth_grant_created'",
          ).all()
        ).results,
      ).toEqual([{ clientId: "hako-web", subjectId: session.id }])
    },
  )

  async function resumeGitHubAuthorization(drift: boolean) {
    const { query, verifier } = authorizationQuery()
    const loginPage = await authorize(query)
    const signed = new URL(
      loginPage.headers.get("location")!,
      origin,
    ).search.slice(1)
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (
        url.origin === "https://github.com" &&
        url.pathname === "/login/oauth/access_token"
      )
        return Response.json({
          access_token: "synthetic",
          token_type: "bearer",
          scope: "read:user user:email",
        })
      if (url.origin === "https://api.github.com" && url.pathname === "/user")
        return Response.json({
          id: Number(env.OWNER_GITHUB_ID),
          login: "owner",
          name: "Owner",
          email: "owner@example.invalid",
        })
      if (
        url.origin === "https://api.github.com" &&
        url.pathname === "/user/emails"
      )
        return Response.json([
          { email: "owner@example.invalid", primary: true, verified: true },
        ])
      throw new Error("Unexpected outbound request")
    })
    const start = await oauthFetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: "/",
        disableRedirect: true,
        oauth_query: signed,
      }),
    })
    expect(start.status).toBe(200)
    const provider = new URL((await start.json<{ url: string }>()).url)
    if (drift)
      await env.DB.prepare(
        "UPDATE oauthClient SET enableEndSession=1 WHERE clientId='hako-web'",
      ).run()
    const response = await oauthFetch(
      `/api/auth/callback/github?${new URLSearchParams({ code: "synthetic-code", state: provider.searchParams.get("state")! })}`,
      {
        headers: {
          cookie: start.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; "),
          accept: "text/html",
        },
      },
    )
    const issued = (
      await env.DB.prepare(
        "SELECT value FROM verification WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') END='authorization_code'",
      ).all()
    ).results
    const audits = (
      await env.DB.prepare(
        "SELECT clientId, subjectId FROM security_audit_events WHERE type='oauth_grant_created'",
      ).all()
    ).results
    return { response, issued, audits, query, verifier }
  }

  it("rejects drift during GitHub login continuation without a misleading login redirect", async () => {
    const { response, issued, audits } = await resumeGitHubAuthorization(true)
    expect(issued).toHaveLength(0)
    expect(audits).toHaveLength(0)
    expect(response.status).toBe(503)
    expect(response.headers.has("location")).toBe(false)
    expect(await response.json()).toMatchObject({
      error: "temporarily_unavailable",
    })
  })

  it("issues and audits the actual client through GitHub login continuation", async () => {
    const { response, issued, audits, query, verifier } =
      await resumeGitHubAuthorization(false)
    expect(response.status).toBe(302)
    const target = new URL(response.headers.get("location")!)
    expect(target.origin + target.pathname).toBe(callback)
    expect(target.searchParams.get("state")).toBe(query.get("state"))
    expect(issued).toHaveLength(1)
    expect(audits).toEqual([
      { clientId: "hako-web", subjectId: expect.any(String) },
    ])
    expect(
      (await exchange(target.searchParams.get("code")!, verifier)).status,
    ).toBe(200)
  })
})

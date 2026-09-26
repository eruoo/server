import { env } from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import {
  issueGrant,
  oauthFetch,
  refresh,
  storedTokenHash,
} from "./fixtures/oauth"
import { ownerSession } from "./fixtures/session"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
  ])
})

function afterEntryOwnerLookup(
  database: D1Database,
  afterLookup: () => Promise<void>,
): D1Database {
  let completed = false
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values))
        const value = Reflect.get(target, property)
        if (typeof value !== "function") return value
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args)
          if (!completed && property === "first" && result) {
            completed = true
            await afterLookup()
          }
          return result
        }
      },
    })
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql)
          // Invalidate identity after the entry check, independently of the
          // authorization-code hook whose persistence check is under test.
          return sql ===
            "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1"
            ? wrap(statement)
            : statement
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

it.each(["valid", "deleted-session", "expired-session", "lost-owner"])(
  "rechecks persistent identity before issuing a code from a warm cookie: %s",
  async (scenario) => {
    const session = await ownerSession()
    const warm = await oauthFetch("/api/auth/get-session", {
      headers: { cookie: session.cookie },
    })
    const cachedCookies = warm.headers
      .getSetCookie()
      .filter((value) => value.startsWith("eruoo.session_data="))
      .map((value) => value.split(";", 1)[0])
    expect(cachedCookies).toHaveLength(1)
    let entryOwnerLookupCompleted = false
    const database = afterEntryOwnerLookup(env.DB, async () => {
      entryOwnerLookupCompleted = true
      if (scenario === "deleted-session")
        await env.DB.prepare("DELETE FROM session WHERE id=?")
          .bind(session.id)
          .run()
      if (scenario === "expired-session")
        await env.DB.prepare("UPDATE session SET expiresAt=? WHERE id=?")
          .bind(new Date(Date.now() - 1000).toISOString(), session.id)
          .run()
      if (scenario === "lost-owner")
        await env.DB.prepare("DELETE FROM account WHERE userId=?")
          .bind(session.id)
          .run()
    })
    const verifier = crypto.randomUUID().repeat(2)
    const callback = "https://hako.eruoo.me/api/auth/callback"
    const query = new URLSearchParams({
      client_id: "hako-web",
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile",
      resource: OAUTH_RESOURCE,
      code_challenge_method: "S256",
      code_challenge: storedTokenHash(verifier),
      state: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
    })
    const response = await oauthFetch(
      `/api/auth/oauth2/authorize?${query}`,
      { headers: { cookie: [session.cookie, ...cachedCookies].join("; ") } },
      database,
    )
    expect(entryOwnerLookupCompleted).toBe(true)
    const codeCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM verification WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') END='authorization_code'",
    ).first("count")
    const auditCount = await env.DB.prepare(
      "SELECT count(*) AS count FROM security_audit_events WHERE type='oauth_grant_created'",
    ).first("count")
    expect({ status: response.status, codeCount, auditCount }).toEqual(
      scenario === "valid"
        ? { status: 302, codeCount: 1, auditCount: 1 }
        : { status: 403, codeCount: 0, auditCount: 0 },
    )
    expect(response.headers.has("location")).toBe(scenario === "valid")
    const error =
      scenario === "valid"
        ? undefined
        : (await response.json<{ error: string }>()).error
    expect(error).toBe(scenario === "valid" ? undefined : "access_denied")
    if (scenario !== "valid") return
    const code = new URL(response.headers.get("location")!).searchParams.get(
      "code",
    )!
    expect(code).toBeTruthy()
    const exchange = await oauthFetch("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "hako-web",
        redirect_uri: callback,
        resource: OAUTH_RESOURCE,
        code,
        code_verifier: verifier,
      }),
    })
    expect(exchange.status).toBe(200)
    const token = await exchange.json<{ access_token: string }>()
    expect(
      (
        await oauthFetch("/api/auth/oauth2/userinfo", {
          headers: { authorization: `Bearer ${token.access_token}` },
        })
      ).status,
    ).toBe(200)
  },
)

it.each([
  "valid",
  "client_secret",
  "empty-secret",
  "basic",
  "client_assertion",
  "other-client",
  "unknown-token",
])("preserves public-client revocation boundaries: %s", async (scenario) => {
  const session = await ownerSession()
  const grant = await issueGrant(session.cookie)
  const body = new URLSearchParams({
    client_id: scenario === "other-client" ? "hako-web" : "eruoo-desktop",
    token:
      scenario === "unknown-token"
        ? "unknown-refresh-token"
        : grant.refresh_token,
    token_type_hint: "refresh_token",
  })
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  }
  if (scenario === "client_secret") body.set("client_secret", "wrong-secret")
  if (scenario === "empty-secret") body.set("client_secret", "")
  if (scenario === "basic")
    headers["authorization"] = `Basic ${btoa("eruoo-desktop:wrong-secret")}`
  if (scenario === "client_assertion") {
    body.set("client_assertion", "invalid.assertion.value")
    body.set(
      "client_assertion_type",
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    )
  }
  const response = await oauthFetch("/api/auth/oauth2/revoke", {
    method: "POST",
    headers,
    body,
  })
  const revoked = await env.DB.prepare(
    "SELECT count(*) AS count FROM oauthRefreshToken WHERE userId=? AND revoked IS NOT NULL",
  )
    .bind(session.id)
    .first("count")
  const tombstones = await env.DB.prepare(
    "SELECT count(*) AS count FROM oauthRefreshTokenFamilyRevocation WHERE userId=?",
  )
    .bind(session.id)
    .first("count")
  const auditCount = await env.DB.prepare(
    "SELECT count(*) AS count FROM security_audit_events WHERE type='oauth_grant_revoked' AND subjectId=?",
  )
    .bind(session.id)
    .first("count")
  const refreshStatus = (await refresh(grant.refresh_token)).status
  const shouldRevoke = scenario === "valid"
  const hasInvalidCredentials = [
    "client_secret",
    "empty-secret",
    "basic",
    "client_assertion",
  ].includes(scenario)
  expect({
    status: response.status,
    revoked,
    tombstones,
    auditCount,
    refreshStatus,
  }).toEqual({
    status: hasInvalidCredentials ? 400 : 200,
    revoked: shouldRevoke ? 1 : 0,
    tombstones: shouldRevoke ? 1 : 0,
    auditCount: shouldRevoke ? 1 : 0,
    refreshStatus: shouldRevoke ? 400 : 200,
  })
  const error = hasInvalidCredentials
    ? (await response.json<{ error: string }>()).error
    : undefined
  expect(error).toBe(hasInvalidCredentials ? "invalid_client" : undefined)
})

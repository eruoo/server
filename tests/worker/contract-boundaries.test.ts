import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import worker from "../../src/worker"
import { origin, storedTokenHash } from "./fixtures/oauth"
import { instrumentDatabase, ownerSession } from "./fixtures/session"
async function call(
  path: string,
  init?: RequestInit,
  database = env.DB,
  limiter = env.AUTH_RATE_LIMITER,
) {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(origin + path, init),
    { ...env, APP_ORIGIN: origin, DB: database, AUTH_RATE_LIMITER: limiter },
    context,
  )
  await waitOnExecutionContext(context)
  return response
}
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM security_audit_events"),
  ])
})
it("serves discovery without D1 or resource initialization and keeps documentation private", async () => {
  let queries = 0
  const unavailable = instrumentDatabase(env.DB, () => {
    queries++
    throw new Error("D1 unavailable")
  })
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource/api",
  ])
    expect((await call(path, undefined, unavailable)).status).toBe(200)
  for (const path of ["/api/docs", "/api/openapi.json"])
    expect((await call(path, undefined, unavailable)).status).toBe(401)
  expect(queries).toBe(0)
  const session = await ownerSession()
  const document = await (
    await call("/api/openapi.json", { headers: { cookie: session.cookie } })
  ).json<{ paths: Record<string, Record<string, unknown>> }>()
  expect(
    Object.values(document.paths).reduce(
      (sum, path) => sum + Object.keys(path).length,
      0,
    ),
  ).toBe(5)
})
it("rejects ambiguous carriers and OAuth coarse limiting before D1", async () => {
  let queries = 0
  const unavailable = instrumentDatabase(env.DB, () => {
    queries++
    throw new Error("D1 unavailable")
  })
  expect(
    (
      await call(
        "/api/status",
        {
          headers: {
            authorization: "Bearer value",
            "x-api-key": "eruoo_value",
          },
        },
        unavailable,
      )
    ).status,
  ).toBe(400)
  const limited = { limit: async () => ({ success: false }) } as RateLimit
  const response = await call(
    "/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code" }),
    },
    unavailable,
    limited,
  )
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("60")
  expect(queries).toBe(0)
})
it.each([" authorization_code ", "\tauthorization_code\n"])(
  "rejects noncanonical grant_type %j before native processing",
  async (grantType) => {
    let queries = 0
    const unavailable = instrumentDatabase(env.DB, () => {
      queries++
      throw new Error("D1 must not be reached")
    })
    const response = await call(
      "/api/auth/oauth2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: grantType }),
      },
      unavailable,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
    expect(queries).toBe(0)
  },
)
it("does not issue an authorization code from a revoked Session's warm cache", async () => {
  const session = await ownerSession()
  const read = await call("/api/auth/get-session", {
    headers: { cookie: session.cookie },
  })
  const cookie = [
    session.cookie,
    ...read.headers
      .getSetCookie()
      .filter((value) => value.startsWith("eruoo.session_data="))
      .map((value) => value.split(";", 1)[0]),
  ].join("; ")
  await env.DB.prepare("DELETE FROM session WHERE id=?").bind(session.id).run()
  const query = new URLSearchParams({
    client_id: "eruoo-desktop",
    redirect_uri: "http://127.0.0.1:49152/oauth/callback",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: storedTokenHash("v".repeat(64)),
    scope: "openid offline_access",
    resource: "https://auth.eruoo.me/api",
    state: "state",
  })
  const response = await call(`/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie },
  })
  expect(response.status).toBe(302)
  expect(new URL(response.headers.get("location")!, origin).pathname).toBe(
    "/login",
  )
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM security_audit_events WHERE type='oauth_grant_created'",
    ).first("count"),
  ).toBe(0)
})

it("exposes the native introspection and logout confirmation contract without anonymous control", async () => {
  const introspection = await call("/api/auth/oauth2/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "unknown" }),
  })
  expect([400, 401]).toContain(introspection.status)
  const confirmation = await call("/api/auth/oauth2/end-session/confirm", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "confirm" }),
  })
  expect([400, 401]).toContain(confirmation.status)
})

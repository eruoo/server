import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS,
  API_KEY_EXPIRATION_HEADER,
} from "../../src/shared/api-key"
import { createAuth } from "../../src/worker/auth"
import { createRequireApiKeyPrincipal } from "../../src/worker/auth/api-key"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { createOwnerSession } from "./fixtures/owner-session"

const dayInSeconds = 24 * 60 * 60

const app = new Hono<AppBindings>()
app.use("*", requestId)
app.use("/fixture", createRequireApiKeyPrincipal(["fixture:read"]))
app.get("/fixture", (context) => context.json(context.var.principal))
app.use("/fixture-error", createRequireApiKeyPrincipal(["fixture:read"]))
app.get("/fixture-error", (context) =>
  context.json({ message: "Synthetic downstream failure" }, 500),
)

async function fetchFixture(
  headers?: HeadersInit,
  path = "/fixture",
  requestEnvironment: Env = env,
): Promise<Response> {
  const executionContext = createExecutionContext()
  const response = await app.fetch(
    new Request(
      `http://local.test${path}`,
      headers === undefined ? {} : { headers },
    ),
    requestEnvironment,
    executionContext,
  )
  await waitOnExecutionContext(executionContext)
  return response
}

function environmentWithUnavailableD1(): Env {
  const unavailableDatabase = new Proxy(env.DB, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return () => {
          throw new Error("Synthetic D1 failure")
        }
      }

      return Reflect.get(target, property, receiver)
    },
  })

  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DB") return unavailableDatabase
      return Reflect.get(target, property, receiver)
    },
  })
}

async function createTestKey(
  permissions: Record<string, string[]> = { fixture: ["read"] },
  expiresIn = 180 * dayInSeconds,
) {
  await createOwnerSession()
  const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
    id: string
  }>()

  if (!owner) {
    throw new Error("Synthetic owner fixture was not created.")
  }

  return createAuth(env).api.createApiKey({
    body: {
      expiresIn,
      name: "Synthetic fixture key",
      permissions,
      userId: owner.id,
    },
  })
}

describe("API key principal middleware", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM apikey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("maps a verified key to a server-derived Principal exactly once", async () => {
    const created = await createTestKey({
      fixture: ["write", "read", "read"],
      notes: ["read"],
    })
    const response = await fetchFixture({ "x-api-key": created.key })
    const principal = await response.json()
    const stored = await env.DB.prepare(
      `SELECT key, rateLimitMax, rateLimitTimeWindow, requestCount
       FROM apikey
       WHERE id = ?`,
    )
      .bind(created.id)
      .first<{
        key: string
        rateLimitMax: number
        rateLimitTimeWindow: number
        requestCount: number
      }>()

    expect(response.status).toBe(200)
    expect(principal).toEqual({
      authMethod: "apiKey",
      credentialId: created.id,
      permissions: ["fixture:read", "fixture:write", "notes:read"],
      scopes: [],
      subject: created.referenceId,
    })
    expect(stored?.key).not.toBe(created.key)
    expect(stored?.rateLimitMax).toBe(
      API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
    )
    expect(stored?.rateLimitTimeWindow).toBe(
      API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS * 1_000,
    )
    expect(stored?.requestCount).toBe(1)
    expect(JSON.stringify(principal)).not.toContain(created.key)
    expect(JSON.stringify(principal)).not.toContain(stored?.key ?? "missing")
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
  })

  it("returns the exact UTC expiration when exactly 14 days remain", async () => {
    const created = await createTestKey()
    const observedAt = Date.now()
    const expiresAt = new Date(observedAt + 14 * dayInSeconds * 1_000)
    await env.DB.prepare("UPDATE apikey SET expiresAt = ? WHERE id = ?")
      .bind(expiresAt.toISOString(), created.id)
      .run()
    const now = vi.spyOn(Date, "now").mockReturnValue(observedAt)

    try {
      const response = await fetchFixture({ "x-api-key": created.key })

      expect(response.status).toBe(200)
      expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBe(
        expiresAt.toISOString(),
      )
    } finally {
      now.mockRestore()
    }
  })

  it("omits the expiration header when the key is one millisecond outside the warning window", async () => {
    const created = await createTestKey()
    const observedAt = Date.now()
    const expiresAt = new Date(observedAt + 14 * dayInSeconds * 1_000 + 1)
    await env.DB.prepare("UPDATE apikey SET expiresAt = ? WHERE id = ?")
      .bind(expiresAt.toISOString(), created.id)
      .run()
    const now = vi.spyOn(Date, "now").mockReturnValue(observedAt)

    try {
      const response = await fetchFixture({ "x-api-key": created.key })

      expect(response.status).toBe(200)
      expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
    } finally {
      now.mockRestore()
    }
  })

  it("does not add the expiration header to a downstream error response", async () => {
    const created = await createTestKey({ fixture: ["read"] }, 7 * dayInSeconds)
    const response = await fetchFixture(
      { "x-api-key": created.key },
      "/fixture-error",
    )

    expect(response.status).toBe(500)
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
  })

  it("fails closed for a legacy permanent key instead of omitting its expiration", async () => {
    const created = await createTestKey()
    await env.DB.prepare("UPDATE apikey SET expiresAt = NULL WHERE id = ?")
      .bind(created.id)
      .run()

    const response = await fetchFixture({ "x-api-key": created.key })

    expect(response.status).toBe(503)
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
  })

  it("maps an unexpected D1 verification failure to 503", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const response = await fetchFixture(
        { "x-api-key": "eruoo_unavailable" },
        "/fixture",
        environmentWithUnavailableD1(),
      )

      expect(response.status).toBe(503)
      expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(await response.json()).toMatchObject({
        status: 503,
        type: "https://auth.eruoo.me/problems/service-unavailable",
      })
    } finally {
      errorLog.mockRestore()
    }
  })

  it("returns 403 after authenticating a key with insufficient permission", async () => {
    const created = await createTestKey({ fixture: ["write"] })
    const response = await fetchFixture({ "x-api-key": created.key })
    const stored = await env.DB.prepare(
      "SELECT requestCount FROM apikey WHERE id = ?",
    )
      .bind(created.id)
      .first<{ requestCount: number }>()
    const audit = await env.DB.prepare(
      `SELECT credentialId, metadata, subjectId
       FROM security_audit_events
       WHERE type = 'api_key_rejected'
       LIMIT 1`,
    ).first<{
      credentialId: string
      metadata: string
      subjectId: string
    }>()

    expect(response.status).toBe(403)
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
    expect(stored?.requestCount).toBe(1)
    expect(audit).toMatchObject({
      credentialId: created.id,
      subjectId: created.referenceId,
    })
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({
      reason: "insufficient_permission",
    })
    expect(JSON.stringify(audit)).not.toContain(created.key)
  })

  it.each([
    { expected: 401, headers: undefined, name: "a missing key" },
    {
      expected: 400,
      headers: { "x-api-key": "invalid key" },
      name: "a malformed key",
    },
    {
      expected: 400,
      headers: {
        authorization: "Bearer synthetic.token",
        "x-api-key": "eruoo_synthetic",
      },
      name: "mixed credential carriers",
    },
    {
      expected: 401,
      headers: { "x-api-key": "eruoo_unknown" },
      name: "an unknown key",
    },
  ])("returns $expected for $name", async ({ expected, headers }) => {
    const response = await fetchFixture(headers)

    expect(response.status).toBe(expected)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
  })

  it("deletes and audits an expired key", async () => {
    const created = await createTestKey()
    await env.DB.prepare("UPDATE apikey SET expiresAt = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), created.id)
      .run()

    const response = await fetchFixture({ "x-api-key": created.key })
    const stored = await env.DB.prepare("SELECT id FROM apikey WHERE id = ?")
      .bind(created.id)
      .first()
    const audit = await env.DB.prepare(
      `SELECT metadata, type
       FROM security_audit_events
       WHERE type = 'api_key_expired'
       LIMIT 1`,
    ).first<{ metadata: string; type: string }>()

    expect(response.status).toBe(401)
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
    expect(stored).toBeNull()
    expect(audit?.type).toBe("api_key_expired")
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({ reason: "expired" })
  })

  it("returns 429 when the verified key exceeds its own rate limit", async () => {
    const created = await createTestKey()
    await env.DB.prepare("DELETE FROM security_audit_events").run()
    await env.DB.prepare(
      `UPDATE apikey
       SET rateLimitMax = 1, rateLimitTimeWindow = 60000,
           requestCount = 0, lastRequest = NULL
       WHERE id = ?`,
    )
      .bind(created.id)
      .run()

    const first = await fetchFixture({ "x-api-key": created.key })
    const second = await fetchFixture({ "x-api-key": created.key })
    const rateLimitAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE type = 'api_key_rejected'`,
    ).first<{ count: number }>()

    expect(first.status).toBe(200)
    expect(second.status).toBe(429)
    expect(second.headers.get("retry-after")).toBe(
      String(API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS),
    )
    expect(rateLimitAudit?.count).toBe(0)
  })

  it("fails closed when stored permission data has an invalid shape", async () => {
    const created = await createTestKey()
    await env.DB.prepare("UPDATE apikey SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify("invalid-permissions"), created.id)
      .run()

    const response = await fetchFixture({ "x-api-key": created.key })

    expect(response.status).toBe(503)
  })

  it("refuses to construct an authorization-free API key middleware", () => {
    expect(() =>
      createRequireApiKeyPrincipal(
        [] as unknown as readonly [string, ...string[]],
      ),
    ).toThrow(TypeError)
  })
})

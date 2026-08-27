import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { Hono } from "hono"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createApp } from "../../src/worker/app"
import {
  AUTH_RATE_LIMIT_WINDOW_SECONDS,
  authRateLimit,
  HIGH_RISK_AUTH_PATHS,
  isHighRiskAuthPath,
  OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH,
  resolveAuthRateLimitPath,
  resolveAuthRateLimitRequestPath,
} from "../../src/worker/auth/rate-limit"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"

const requiredHighRiskPaths = [
  "/api/auth/api-key/create",
  "/api/auth/api-key/delete",
  "/api/auth/api-key/update",
  "/api/auth/callback/github",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/token",
  "/api/auth/passkey/delete-passkey",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/update-passkey",
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/verify-registration",
  "/api/auth/sign-in/social",
  OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH,
] as const

function environmentWithRateLimiter(limit: RateLimit["limit"]): Env {
  const rateLimiter = { limit } satisfies RateLimit

  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "AUTH_RATE_LIMITER") {
        return rateLimiter
      }

      return Reflect.get(target, property, receiver)
    },
  })
}

function createFixture(downstream: () => void) {
  const fixture = new Hono<AppBindings>({ strict: true })
  fixture.use("*", requestId)
  fixture.use("*", authRateLimit)
  fixture.all("*", (context) => {
    downstream()
    return context.json({ status: "ok" })
  })
  return fixture
}

async function fetchFixture(options: {
  downstream?: () => void
  headers?: HeadersInit
  limit: RateLimit["limit"]
  method?: string
  path: string
}): Promise<Response> {
  const fixture = createFixture(options.downstream ?? vi.fn<() => void>())
  const headers = new Headers(options.headers)
  headers.set("x-request-id", "auth-rate-limit-test")
  return fixture.fetch(
    new Request(`http://local.test${options.path}`, {
      headers,
      ...(options.method === undefined ? {} : { method: options.method }),
    }),
    environmentWithRateLimiter(options.limit),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("high-risk authentication paths", () => {
  it("exports every required high-risk authentication path", () => {
    expect(HIGH_RISK_AUTH_PATHS).toEqual(
      expect.arrayContaining([...requiredHighRiskPaths]),
    )

    for (const path of requiredHighRiskPaths) {
      expect(isHighRiskAuthPath(path)).toBe(true)
    }
  })

  it.each([
    "/api/auth/get-session",
    "/api/auth/jwks",
    "/api/auth/passkey/list-user-passkeys",
    "/api/oauth/authorizations",
    "/api/oauth/authorizations/eruoo-desktop/devices",
    "/api/status",
  ])("does not classify %s as high risk", (path) => {
    expect(isHighRiskAuthPath(path)).toBe(false)
  })

  it.each([
    "/api/oauth/authorizations/eruoo-desktop",
    "/api/oauth/authorizations/eruoo-mobile",
    "/api/oauth/authorizations/unregistered-client",
  ])("normalizes owner revocation path %s", (path) => {
    expect(isHighRiskAuthPath(path)).toBe(true)
    expect(resolveAuthRateLimitPath(path)).toBe(
      OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH,
    )
  })

  it("limits only DELETE on the dynamic owner revocation path", () => {
    const path = "/api/oauth/authorizations/eruoo-desktop"

    expect(resolveAuthRateLimitRequestPath("DELETE", path)).toBe(
      OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH,
    )
    expect(resolveAuthRateLimitRequestPath("GET", path)).toBeUndefined()
    expect(resolveAuthRateLimitRequestPath("OPTIONS", path)).toBeUndefined()
  })
})

describe("authentication rate-limit middleware", () => {
  it.each([
    { method: "OPTIONS", path: "/api/auth/oauth2/token" },
    {
      method: "OPTIONS",
      path: "/api/oauth/authorizations/eruoo-desktop",
    },
    { method: "GET", path: "/api/auth/get-session" },
  ])("skips $method $path", async ({ method, path }) => {
    const downstream = vi.fn<() => void>()
    const limit = vi.fn<RateLimit["limit"]>()

    const response = await fetchFixture({ downstream, limit, method, path })

    expect(response.status).toBe(200)
    expect(limit).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledOnce()
  })

  it("uses one canonical limiter key for every owner revocation client ID", async () => {
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: true })
    const paths = [
      "/api/oauth/authorizations/eruoo-desktop",
      "/api/oauth/authorizations/eruoo-mobile",
      "/api/oauth/authorizations/unregistered-client",
    ]

    for (const path of paths) {
      const response = await fetchFixture({
        headers: { "CF-Connecting-IP": "203.0.113.10" },
        limit,
        method: "DELETE",
        path,
      })
      expect(response.status).toBe(200)
    }

    expect(limit).toHaveBeenCalledTimes(paths.length)
    for (const [options] of limit.mock.calls) {
      expect(options).toEqual({
        key: `${OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH}:203.0.113.10`,
      })
    }
  })

  it.each([
    {
      expectedKey: "/api/auth/oauth2/token:203.0.113.10",
      headers: { "CF-Connecting-IP": "203.0.113.10" },
      name: "the connecting IP",
    },
    {
      expectedKey: "/api/auth/oauth2/token:unknown",
      headers: undefined,
      name: "unknown when the connecting IP is missing",
    },
  ])("keys the limiter by path and $name", async ({ expectedKey, headers }) => {
    const downstream = vi.fn<() => void>()
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: true })

    const response = await fetchFixture({
      downstream,
      ...(headers === undefined ? {} : { headers }),
      limit,
      method: "POST",
      path: "/api/auth/oauth2/token",
    })

    expect(response.status).toBe(200)
    expect(limit).toHaveBeenCalledOnce()
    expect(limit).toHaveBeenCalledWith({ key: expectedKey })
    expect(downstream).toHaveBeenCalledOnce()
  })

  it("returns a no-store 429 before downstream audit work when rejected", async () => {
    const downstream = vi.fn<() => void>()
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: false })

    const response = await fetchFixture({
      downstream,
      limit,
      method: "POST",
      path: "/api/auth/sign-in/social",
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe(
      String(AUTH_RATE_LIMIT_WINDOW_SECONDS),
    )
    await expect(response.json()).resolves.toMatchObject({
      requestId: "auth-rate-limit-test",
      status: 429,
      type: "https://auth.eruoo.me/problems/rate-limit-exceeded",
    })
    expect(downstream).not.toHaveBeenCalled()
  })

  it("fails closed with a structured error when the binding throws", async () => {
    const downstream = vi.fn<() => void>()
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockRejectedValue(new Error("binding unavailable"))
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)

    const response = await fetchFixture({
      downstream,
      headers: { "CF-Connecting-IP": "203.0.113.10" },
      limit,
      method: "GET",
      path: "/api/auth/callback/github",
    })

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toMatchObject({
      requestId: "auth-rate-limit-test",
      status: 503,
      type: "https://auth.eruoo.me/problems/service-unavailable",
    })
    expect(consoleError).toHaveBeenCalledWith({
      error: "Error",
      event: "auth_rate_limit_dependency_failed",
      path: "/api/auth/callback/github",
      requestId: "auth-rate-limit-test",
    })
    expect(downstream).not.toHaveBeenCalled()
  })
})

describe("owner OAuth authorization revocation rate limit", () => {
  it("rejects before recent-session audit work", async () => {
    await env.DB.prepare("DELETE FROM security_audit_events").run()
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: false })
    const executionContext = createExecutionContext()

    const response = await createApp().fetch(
      new Request(
        "http://local.test/api/oauth/authorizations/unregistered-client",
        {
          headers: { "CF-Connecting-IP": "203.0.113.10" },
          method: "DELETE",
        },
      ),
      environmentWithRateLimiter(limit),
      executionContext,
    )
    await waitOnExecutionContext(executionContext)

    expect(response.status).toBe(429)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe(
      String(AUTH_RATE_LIMIT_WINDOW_SECONDS),
    )
    expect(limit).toHaveBeenCalledWith({
      key: `${OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH}:203.0.113.10`,
    })
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE type = 'sensitive_operation_denied'`,
    ).first<{ count: number }>()
    expect(auditCount?.count).toBe(0)
  })

  it("does not authenticate or audit unsupported OPTIONS requests", async () => {
    await env.DB.prepare("DELETE FROM security_audit_events").run()
    const limit = vi
      .fn<RateLimit["limit"]>()
      .mockResolvedValue({ success: true })
    const executionContext = createExecutionContext()

    const response = await createApp().fetch(
      new Request("http://local.test/api/oauth/authorizations/eruoo-desktop", {
        method: "OPTIONS",
      }),
      environmentWithRateLimiter(limit),
      executionContext,
    )
    await waitOnExecutionContext(executionContext)

    expect(response.status).toBe(404)
    expect(limit).not.toHaveBeenCalled()
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM security_audit_events
       WHERE type = 'sensitive_operation_denied'`,
    ).first<{ count: number }>()
    expect(auditCount?.count).toBe(0)
  })
})

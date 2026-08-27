import { env, SELF } from "cloudflare:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { describe, expect, it, vi } from "vitest"

import {
  createApp,
  handleAppError,
  usesApplicationTimeout,
} from "../../src/worker/app"
import { requireOwnerSession } from "../../src/worker/auth/session"
import { createConfiguredCors } from "../../src/worker/http/cors"
import { configuredCsrf } from "../../src/worker/http/csrf"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { createOwnerSession } from "./fixtures/owner-session"

const allowedOrigin = "https://web.example.invalid"
const rejectedOrigin = "https://web.example.invalid.attacker.example"

function environmentWithCorsAllowlist(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "ALLOWED_CORS_ORIGINS") {
        return JSON.stringify([allowedOrigin])
      }

      return Reflect.get(target, property, receiver)
    },
  })
}

const corsFixture = new Hono<AppBindings>({ strict: true })
corsFixture.use(
  "*",
  createConfiguredCors(
    new Set(["GET /api/fixture", "GET /api/key-fixture", "POST /api/fixture"]),
    new Set(["GET /api/key-fixture"]),
  ),
)
corsFixture.all("/api/fixture", (context) => context.json({ status: "ok" }))
corsFixture.get("/api/key-fixture", (context) => context.json({ status: "ok" }))
corsFixture.all("/api/unlisted", (context) => context.json({ status: "ok" }))

async function fetchCorsFixture(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return corsFixture.fetch(
    new Request(`http://local.test${path}`, init),
    environmentWithCorsAllowlist(),
  )
}

const csrfFixture = new Hono<AppBindings>({ strict: true })
csrfFixture.use("*", requestId)
csrfFixture.use("/api/*", configuredCsrf)
csrfFixture.post("/api/fixture", (context) => context.body(null, 204))
csrfFixture.use("/api/protected", requireOwnerSession)
csrfFixture.post("/api/protected", (context) => context.body(null, 204))

const timeoutErrorFixture = new Hono<AppBindings>({ strict: true })
timeoutErrorFixture.use("*", requestId)
timeoutErrorFixture.post("/api/auth/oauth2/token", () => {
  throw new HTTPException(504, { message: "The request timed out." })
})
timeoutErrorFixture.onError(handleAppError)

async function postCsrfFixture(headers?: HeadersInit): Promise<Response> {
  return csrfFixture.fetch(
    new Request("http://local.test/api/fixture", {
      headers: {
        "content-type": "text/plain",
        ...headers,
      },
      method: "POST",
    }),
    env,
  )
}

async function createFreshOwnerSession(): Promise<string> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM user"),
  ])
  return createOwnerSession()
}

describe("CORS boundaries", () => {
  it("echoes only an exact allowlisted Origin without enabling credentials", async () => {
    const response = await fetchCorsFixture("/api/fixture", {
      headers: { origin: allowedOrigin },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-Request-ID",
    )
    expect(response.headers.get("vary")).toContain("Origin")
  })

  it("handles an allowlisted preflight before route authentication", async () => {
    const response = await fetchCorsFixture("/api/fixture", {
      headers: {
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-method": "POST",
        origin: allowedOrigin,
      },
      method: "OPTIONS",
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET,POST,OPTIONS",
    )
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization,Content-Type,X-Request-ID",
    )
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    expect(response.headers.get("access-control-max-age")).toBe("600")
  })

  it("does not return an allow-Origin header for an unknown Origin", async () => {
    const response = await fetchCorsFixture("/api/fixture", {
      headers: { origin: rejectedOrigin },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })

  it("does not enable CORS for an operation missing from the explicit allowlist", async () => {
    const response = await fetchCorsFixture("/api/unlisted", {
      headers: { origin: allowedOrigin },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("allows and exposes API key headers only for an explicit API key operation", async () => {
    const preflight = await fetchCorsFixture("/api/key-fixture", {
      headers: {
        "access-control-request-headers": "x-api-key",
        "access-control-request-method": "GET",
        origin: allowedOrigin,
      },
      method: "OPTIONS",
    })
    const response = await fetchCorsFixture("/api/key-fixture", {
      headers: { origin: allowedOrigin },
    })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "X-API-Key",
    )
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "API-Key-Expires-At,X-Request-ID",
    )
  })

  it("rejects an API key CORS operation outside the main allowlist", () => {
    expect(() =>
      createConfiguredCors(new Set(), new Set(["GET /api/key-fixture"])),
    ).toThrow(TypeError)
  })

  it("keeps Better Auth private while exposing the status API-key operation", async () => {
    const app = createApp()
    const testEnv = environmentWithCorsAllowlist()
    const authResponse = await app.fetch(
      new Request("http://local.test/api/auth", {
        headers: { origin: allowedOrigin },
      }),
      testEnv,
    )
    const nestedAuthResponse = await app.fetch(
      new Request("http://local.test/api/auth/get-session", {
        headers: { origin: allowedOrigin },
      }),
      testEnv,
    )
    const statusResponse = await app.fetch(
      new Request("http://local.test/api/status", {
        headers: { origin: allowedOrigin },
      }),
      testEnv,
    )
    const statusPreflight = await app.fetch(
      new Request("http://local.test/api/status", {
        headers: {
          "access-control-request-headers": "x-api-key",
          "access-control-request-method": "GET",
          origin: allowedOrigin,
        },
        method: "OPTIONS",
      }),
      testEnv,
    )

    expect(authResponse.headers.get("access-control-allow-origin")).toBeNull()
    expect(
      nestedAuthResponse.headers.get("access-control-allow-origin"),
    ).toBeNull()
    expect(statusResponse.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
    expect(statusResponse.headers.get("access-control-expose-headers")).toBe(
      "API-Key-Expires-At,X-Request-ID",
    )
    expect(statusPreflight.status).toBe(204)
    expect(statusPreflight.headers.get("access-control-allow-origin")).toBe(
      allowedOrigin,
    )
    expect(statusPreflight.headers.get("access-control-allow-methods")).toBe(
      "GET,OPTIONS",
    )
    expect(
      statusPreflight.headers.get("access-control-allow-headers"),
    ).toContain("X-API-Key")
  })

  it("does not expose Better Auth's built-in health endpoint", async () => {
    const response = await createApp().fetch(
      new Request("http://local.test/api/auth/ok"),
      env,
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("does not expose disabled dynamic Better Auth routes", async () => {
    const response = await createApp().fetch(
      new Request(
        "http://local.test/api/auth/reset-password/synthetic-token?callbackURL=http%3A%2F%2Flocal.test%2Flogin",
      ),
      env,
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("location")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("redirects OAuth callback failures to the SPA instead of an auth route", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/callback/github",
      { redirect: "manual" },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "http://localhost:5173/login?error=state_not_found",
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

describe("CSRF boundaries", () => {
  it("rejects an unsafe request carrying an ambient Session cookie", async () => {
    const response = await postCsrfFixture({
      cookie: "eruoo.session_token=synthetic",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    })

    expect(response.status).toBe(403)
  })

  it("maps a custom API CSRF rejection to permission-denied Problem Details", async () => {
    const cookie = await createFreshOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/oauth/authorizations/eruoo-desktop",
      {
        headers: {
          "content-type": "text/plain",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "DELETE",
      },
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 403,
      title: "Permission denied",
      type: "https://auth.eruoo.me/problems/permission-denied",
    })
  })

  it.each([
    {
      headers: { authorization: "Bearer synthetic.token" },
      name: "a Bearer token",
    },
    {
      headers: { "x-api-key": "eruoo_synthetic" },
      name: "an API key",
    },
    { headers: undefined, name: "no credential" },
  ])(
    "does not apply ambient-credential CSRF checks to $name",
    async ({ headers }) => {
      const response = await postCsrfFixture(headers)

      expect(response.status).toBe(204)
    },
  )

  it("lets route authentication return the canonical 400 for mixed carriers", async () => {
    const response = await csrfFixture.fetch(
      new Request("http://local.test/api/protected", {
        headers: {
          "content-type": "text/plain",
          cookie: "eruoo.session_token=synthetic",
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "x-api-key": "eruoo_synthetic",
        },
        method: "POST",
      }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      status: 400,
      title: "Invalid request",
    })
  })
})

describe("strict API routing", () => {
  it("does not treat /api/status/ as /api/status", async () => {
    const cookie = await createFreshOwnerSession()
    const headers = { cookie: `eruoo.session_token=${cookie}` }
    const exactResponse = await createApp().fetch(
      new Request("http://local.test/api/status", { headers }),
      env,
    )
    const trailingSlashResponse = await createApp().fetch(
      new Request("http://local.test/api/status/", { headers }),
      env,
    )

    expect(exactResponse.status).toBe(200)
    expect(trailingSlashResponse.status).toBe(404)
  })

  it("does not synthesize HEAD operations for custom API GET routes", async () => {
    for (const path of [
      "/api/status",
      "/api/security/audit-events",
      "/api/oauth/authorizations",
      "/api/openapi.json",
    ]) {
      const response = await SELF.fetch(`http://local.test${path}`, {
        method: "HEAD",
      })

      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(await response.text()).toBe("")
    }

    const betterAuthResponse = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      { method: "HEAD" },
    )
    expect(betterAuthResponse.status).toBe(404)
    expect(betterAuthResponse.headers.get("content-type")).toContain(
      "application/json",
    )
    expect(betterAuthResponse.headers.get("content-type")).not.toContain(
      "application/problem+json",
    )
  })

  it("returns the documented 413 for an oversized authorization revocation body", async () => {
    const cookie = await createFreshOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/oauth/authorizations/eruoo-desktop",
      {
        body: "a".repeat(1024 * 1024 + 1),
        headers: {
          "content-type": "application/octet-stream",
          cookie: `eruoo.session_token=${cookie}`,
        },
        method: "DELETE",
      },
    )

    expect(response.status).toBe(413)
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 413,
      type: "https://auth.eruoo.me/problems/payload-too-large",
    })
  })
})

describe("OAuth transport failures", () => {
  it("maps token timeouts to a stable non-protocol 503 response", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const response = await timeoutErrorFixture.fetch(
        new Request("http://local.test/api/auth/oauth2/token", {
          method: "POST",
        }),
        env,
      )

      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      await expect(response.json()).resolves.toEqual({
        code: "OAUTH_TOKEN_SERVICE_UNAVAILABLE",
        message: "The OAuth token service is temporarily unavailable.",
      })
    } finally {
      errorLog.mockRestore()
    }
  })
})

describe("application timeout boundaries", () => {
  it.each([
    ["GET", "/api/status", true],
    ["HEAD", "/api/openapi.json", true],
    ["POST", "/api/oauth/authorizations/client", false],
    ["DELETE", "/api/oauth/authorizations/client", false],
    ["POST", "/api/auth/oauth2/token", false],
    ["GET", "/api/auth/get-session", false],
    ["GET", "/problems/not-found", false],
  ])("selects %s %s = %s", (method, path, expected) => {
    expect(usesApplicationTimeout(method, path)).toBe(expected)
  })
})

describe("runtime security configuration", () => {
  it("fails closed before serving requests when the audit secret is undersized", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const invalidEnvironment = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "AUDIT_IP_HASH_SECRET") return "too-short"
        return Reflect.get(target, property, receiver)
      },
    })

    try {
      const response = await createApp().fetch(
        new Request("http://local.test/api/status"),
        invalidEnvironment,
      )

      expect(response.status).toBe(500)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      await expect(response.json()).resolves.toMatchObject({
        status: 500,
        type: "https://auth.eruoo.me/problems/internal-error",
      })
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "InvalidAuditSecretError",
          event: "request_failed",
        }),
      )
    } finally {
      errorLog.mockRestore()
    }
  })
})

import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { API_KEY_EXPIRATION_HEADER } from "../../src/shared/api-key"
import { createAuth } from "../../src/worker/auth"
import { createOwnerSession } from "./fixtures/owner-session"

const dayInSeconds = 24 * 60 * 60

async function createStatusApiKey(
  permissions: Record<string, string[]> = { status: ["read"] },
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
      expiresIn: 180 * dayInSeconds,
      name: "Synthetic status key",
      permissions,
      userId: owner.id,
    },
  })
}

describe("GET /api/status", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM apikey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("returns the exact status contract for a persisted owner Session", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        cookie: `eruoo.session_token=${cookie}`,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("requires an owner session without performing a public health probe", async () => {
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        "x-request-id": "test-status-request",
      },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
    expect(response.headers.get("x-request-id")).toBe("test-status-request")
    expect(await response.json()).toMatchObject({
      requestId: "test-status-request",
      status: 401,
      title: "Authentication required",
      type: "https://auth.eruoo.me/problems/authentication-required",
    })
  })

  it("accepts a finite status:read API key without requiring a Session", async () => {
    const apiKey = await createStatusApiKey()
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        "x-api-key": apiKey.key,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
    expect(await response.json()).toEqual({ status: "ok" })
  })

  it("rejects an unknown API key", async () => {
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        "x-api-key": "eruoo_synthetic",
      },
    })

    expect(response.status).toBe(401)
  })

  it("rejects an authenticated API key without status:read", async () => {
    const apiKey = await createStatusApiKey({ status: ["write"] })
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        "x-api-key": apiKey.key,
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get(API_KEY_EXPIRATION_HEADER)).toBeNull()
    await expect(response.json()).resolves.toMatchObject({
      status: 403,
      type: "https://auth.eruoo.me/problems/insufficient-permission",
    })
  })

  it("rejects ambiguous credential carriers before validating either", async () => {
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        cookie: "eruoo.session_token=synthetic",
        "x-api-key": "eruoo_synthetic",
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      status: 400,
      title: "Invalid request",
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
  })

  it("rejects duplicate Session cookies", async () => {
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        cookie: "eruoo.session_token=first; eruoo.session_token=second",
      },
    })

    expect(response.status).toBe(400)
  })

  it("replaces an unsafe upstream request ID", async () => {
    const response = await SELF.fetch("http://local.test/api/status", {
      headers: {
        "x-request-id": "unsafe request id with spaces",
      },
    })
    const requestId = response.headers.get("x-request-id")

    expect(requestId).not.toBe("unsafe request id with spaces")
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

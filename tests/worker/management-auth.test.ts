import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { createAuth } from "../../src/worker/auth"
import { createOwnerSession } from "./fixtures/owner-session"

const dayInSeconds = 24 * 60 * 60
const apiKeyLifetimeInSeconds = 180 * dayInSeconds

const managementPaths = [
  "/api/auth/api-key/list",
  "/api/auth/passkey/list-user-passkeys",
] as const

describe("owner authentication on Better Auth management routes", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM apikey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  for (const path of managementPaths) {
    it(`requires an owner Session for ${path}`, async () => {
      const response = await SELF.fetch(`http://local.test${path}`)

      expect(response.status).toBe(401)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
    })

    it(`rejects mixed credential carriers for ${path}`, async () => {
      const response = await SELF.fetch(`http://local.test${path}`, {
        headers: {
          cookie: "eruoo.session_token=synthetic",
          "x-api-key": "eruoo_synthetic",
        },
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        status: 400,
        title: "Invalid request",
      })
    })
  }

  it("does not expose API-key verification as a public body endpoint", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/verify",
      {
        body: JSON.stringify({ key: "synthetic-raw-key" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    )

    expect(response.status).toBe(404)
  })

  it("rejects attempts to turn an API key into a permanent credential", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/update",
      {
        body: JSON.stringify({
          expiresIn: null,
          keyId: "synthetic-key-id",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      status: 422,
      title: "API key expiration required",
      type: "https://auth.eruoo.me/problems/api-key-expiration-required",
    })
  })

  it("creates a 180-day status:read key and never returns its raw value again", async () => {
    const cookie = await createOwnerSession()
    const beforeCreation = Date.now()
    const createResponse = await SELF.fetch(
      "http://local.test/api/auth/api-key/create",
      {
        body: JSON.stringify({
          expiresIn: apiKeyLifetimeInSeconds,
          name: "Status client",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(createResponse.status).toBe(200)
    const created = (await createResponse.json()) as {
      expiresAt: string
      id: string
      key: string
      permissions: Record<string, string[]>
    }
    const stored = await env.DB.prepare(
      "SELECT expiresAt, key, permissions FROM apikey WHERE id = ?",
    )
      .bind(created.id)
      .first<{
        expiresAt: string
        key: string
        permissions: string
      }>()

    expect(created.key).toMatch(/^eruoo_/)
    expect(created.permissions).toEqual({ status: ["read"] })
    expect(stored?.key).not.toBe(created.key)
    expect(JSON.parse(stored?.permissions ?? "null")).toEqual({
      status: ["read"],
    })
    expect(new Date(stored?.expiresAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      beforeCreation + apiKeyLifetimeInSeconds * 1_000 - 1_000,
    )
    expect(new Date(stored?.expiresAt ?? 0).getTime()).toBeLessThanOrEqual(
      Date.now() + apiKeyLifetimeInSeconds * 1_000 + 1_000,
    )

    const listResponse = await SELF.fetch(
      "http://local.test/api/auth/api-key/list",
      {
        headers: {
          cookie: `eruoo.session_token=${cookie}`,
        },
      },
    )
    const listed = (await listResponse.json()) as {
      apiKeys: Array<Record<string, unknown>>
    }

    expect(listResponse.status).toBe(200)
    expect(JSON.stringify(listed)).not.toContain(created.key)
    expect(listed.apiKeys).toHaveLength(1)
    expect(listed.apiKeys[0]).not.toHaveProperty("key")
  })

  it("rejects a body access token before API-key creation", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/create",
      {
        body: JSON.stringify({
          access_token: "synthetic-access-token",
          expiresIn: apiKeyLifetimeInSeconds,
          name: "Rejected status client",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    )
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
    expect(
      await env.DB.prepare("SELECT id FROM apikey LIMIT 1").first(),
    ).toBeNull()
  })

  it.each([
    {
      body: {
        expiresIn: apiKeyLifetimeInSeconds,
        name: "Explicit default permissions",
        permissions: { status: ["read"] },
      },
      name: "explicit status:read permissions",
    },
    {
      body: {
        expiresIn: apiKeyLifetimeInSeconds,
        name: "Expanded permissions",
        permissions: { status: ["read"], users: ["read"] },
      },
      name: "permissions beyond status:read",
    },
  ])("rejects API-key creation with $name", async ({ body }) => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/create",
      {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/insufficient-permission",
    })
    expect(
      await env.DB.prepare("SELECT id FROM apikey LIMIT 1").first(),
    ).toBeNull()
  })

  it("rejects all client-side permission updates", async () => {
    const cookie = await createOwnerSession()
    const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
      id: string
    }>()

    if (!owner) {
      throw new Error("Synthetic owner fixture was not created.")
    }

    const apiKey = await createAuth(env).api.createApiKey({
      body: {
        expiresIn: apiKeyLifetimeInSeconds,
        name: "Update permissions",
        permissions: { status: ["read"] },
        userId: owner.id,
      },
    })
    const exactResponse = await SELF.fetch(
      "http://local.test/api/auth/api-key/update",
      {
        body: JSON.stringify({
          keyId: apiKey.id,
          permissions: { status: ["read"] },
        }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )
    const expandedResponse = await SELF.fetch(
      "http://local.test/api/auth/api-key/update",
      {
        body: JSON.stringify({
          keyId: apiKey.id,
          permissions: { status: ["read", "write"] },
        }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(exactResponse.status).toBe(403)
    expect(await exactResponse.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/insufficient-permission",
    })
    expect(expandedResponse.status).toBe(403)
    expect(await expandedResponse.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/insufficient-permission",
    })
  })

  it("lets a recently authenticated owner revoke a finite API key", async () => {
    const cookie = await createOwnerSession()
    const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
      id: string
    }>()

    if (!owner) {
      throw new Error("Synthetic owner fixture was not created.")
    }

    const apiKey = await createAuth(env).api.createApiKey({
      body: {
        expiresIn: apiKeyLifetimeInSeconds,
        name: "Synthetic revocable key",
        permissions: { fixture: ["read"] },
        userId: owner.id,
      },
    })
    const existing = await env.DB.prepare(
      "SELECT expiresAt FROM apikey WHERE id = ?",
    )
      .bind(apiKey.id)
      .first<{ expiresAt: string | null }>()

    expect(existing?.expiresAt).not.toBeNull()
    expect(new Date(existing?.expiresAt ?? 0).getTime()).toBeGreaterThan(
      Date.now(),
    )

    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/delete",
      {
        body: JSON.stringify({ keyId: apiKey.id }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )
    const stored = await env.DB.prepare("SELECT id FROM apikey WHERE id = ?")
      .bind(apiKey.id)
      .first()
    const audit = await env.DB.prepare(
      `SELECT outcome, subjectId, type
       FROM security_audit_events
       WHERE type = 'api_key_revoked'
       ORDER BY occurredAt DESC
       LIMIT 1`,
    ).first<{ outcome: string; subjectId: string | null; type: string }>()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(stored).toBeNull()
    expect(audit).toEqual({
      outcome: "success",
      subjectId: owner.id,
      type: "api_key_revoked",
    })
  })

  it("audits a stale-session denial before the sensitive handler runs", async () => {
    const cookie = await createOwnerSession({
      reauthenticatedAt: new Date(Date.now() - 16 * 60 * 1000),
    })
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/delete",
      {
        body: JSON.stringify({ keyId: "synthetic-key-id" }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(403)

    const row = await env.DB.prepare(
      `SELECT type, outcome, metadata
       FROM security_audit_events
       WHERE type = 'sensitive_operation_denied'
       ORDER BY occurredAt DESC
       LIMIT 1`,
    ).first<{ metadata: string; outcome: string; type: string }>()

    expect(row).toMatchObject({
      outcome: "failure",
      type: "sensitive_operation_denied",
    })
    expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
      reason: "recent_authentication_required",
      status: 403,
    })
  })

  it("rejects a future reauthentication timestamp fail closed", async () => {
    const cookie = await createOwnerSession({
      reauthenticatedAt: new Date(Date.now() + 60 * 1000),
    })
    const response = await SELF.fetch(
      "http://local.test/api/auth/api-key/delete",
      {
        body: JSON.stringify({ keyId: "synthetic-key-id" }),
        headers: {
          "content-type": "application/json",
          cookie: `eruoo.session_token=${cookie}`,
          origin: "http://localhost:5173",
        },
        method: "POST",
      },
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      title: "Recent authentication required",
    })
  })

  it.each([
    {
      expectedStatus: 401,
      headers: { "content-type": "application/json" },
      name: "missing credentials",
    },
    {
      expectedStatus: 400,
      headers: {
        "content-type": "application/json",
        cookie: "eruoo.session_token=synthetic",
        "x-api-key": "eruoo_synthetic",
      },
      name: "mixed credential carriers",
    },
  ])(
    "audits $name on a sensitive route",
    async ({ expectedStatus, headers }) => {
      const response = await SELF.fetch(
        "http://local.test/api/auth/api-key/delete",
        {
          body: JSON.stringify({ keyId: "synthetic-key-id" }),
          headers,
          method: "POST",
        },
      )

      expect(response.status).toBe(expectedStatus)

      const row = await env.DB.prepare(
        `SELECT type, outcome, metadata
       FROM security_audit_events
       WHERE type = 'sensitive_operation_denied'
       ORDER BY occurredAt DESC
       LIMIT 1`,
      ).first<{ metadata: string; outcome: string; type: string }>()

      expect(row).toMatchObject({
        outcome: "failure",
        type: "sensitive_operation_denied",
      })
      expect(JSON.parse(row?.metadata ?? "{}")).toMatchObject({
        reason: "credential_rejected",
        status: expectedStatus,
      })
    },
  )
})

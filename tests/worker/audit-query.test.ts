import { OpenAPIHono } from "@hono/zod-openapi"
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { recordAuditEvent } from "../../src/worker/audit"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { auditEventsRouter } from "../../src/worker/routes/audit"
import { createOwnerSession } from "./fixtures/owner-session"

const app = new OpenAPIHono<AppBindings>({ strict: true })
app.use("*", requestId)
app.route("/", auditEventsRouter)

interface TestAuditEvent {
  clientId?: string
  credentialId?: string
  id: string
  ipFingerprint?: string
  metadata?: Record<string, boolean | number | string>
  occurredAt: number
  outcome: "failure" | "success"
  subjectId?: string
  type: "github_login" | "passkey_created"
}

async function insertEvents(events: readonly TestAuditEvent[]) {
  await env.DB.batch(
    events.map((event) =>
      env.DB.prepare(
        `INSERT INTO security_audit_events (
           id, type, outcome, occurredAt, subjectId, credentialId,
           clientId, ipFingerprint, requestId, metadata
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        event.id,
        event.type,
        event.outcome,
        event.occurredAt,
        event.subjectId ?? null,
        event.credentialId ?? null,
        event.clientId ?? null,
        event.ipFingerprint ?? null,
        `request-${event.id}`,
        JSON.stringify(event.metadata ?? { source: "test" }),
      ),
    ),
  )
}

async function fetchAudit(
  path = "/api/security/audit-events",
  headers?: HeadersInit,
): Promise<Response> {
  const executionContext = createExecutionContext()
  const response = await app.fetch(
    new Request(
      `http://local.test${path}`,
      headers === undefined ? undefined : { headers },
    ),
    env,
    executionContext,
  )
  await waitOnExecutionContext(executionContext)
  return response
}

describe("GET /api/security/audit-events", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("registers the owner-only OpenAPI contract and epoch-millisecond fields", () => {
    const document = auditEventsRouter.getOpenAPI31Document({
      info: { title: "Audit contract test", version: "test" },
      openapi: "3.1.0",
    })
    const operation = document.paths?.["/api/security/audit-events"]?.get
    const limit = operation?.parameters?.find(
      (parameter) => "name" in parameter && parameter.name === "limit",
    )
    const auditEvent = document.components?.schemas?.["SecurityAuditEvent"]

    if (!limit || !("schema" in limit)) {
      throw new Error("The audit limit OpenAPI parameter is missing.")
    }

    if (!auditEvent || !("properties" in auditEvent)) {
      throw new Error("The audit event OpenAPI schema is missing.")
    }

    const occurredAt = auditEvent.properties?.["occurredAt"]

    if (!occurredAt || !("type" in occurredAt)) {
      throw new Error("The audit occurredAt OpenAPI field is missing.")
    }

    expect(operation).toMatchObject({
      operationId: "listSecurityAuditEvents",
      security: [{ ownerSession: [] }],
    })
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "422",
      "500",
      "503",
      "504",
    ])
    expect(limit?.schema).toMatchObject({
      maximum: 100,
      minimum: 1,
      type: "integer",
    })
    expect(occurredAt).toMatchObject({
      format: "int64",
      type: "integer",
    })
  })

  it.each([
    { headers: undefined, name: "missing credentials" },
    { headers: { "x-api-key": "eruoo_synthetic" }, name: "an API key" },
    {
      headers: { authorization: "Bearer synthetic.token" },
      name: "an OAuth bearer token",
    },
  ])(
    "rejects $name instead of treating it as an owner Session",
    async ({ headers }) => {
      const response = await fetchAudit("/api/security/audit-events", headers)

      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(await response.json()).toMatchObject({
        status: 401,
        type: "https://auth.eruoo.me/problems/authentication-required",
      })
    },
  )

  it("rejects ambiguous credential carriers before querying D1", async () => {
    const response = await fetchAudit("/api/security/audit-events", {
      authorization: "Bearer synthetic.token",
      cookie: "eruoo.session_token=synthetic",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      status: 400,
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
  })

  it("paginates with an exclusive opaque keyset cursor", async () => {
    const cookie = await createOwnerSession()
    const now = Date.now()
    await insertEvents([
      {
        id: "event-a",
        occurredAt: now - 1_000,
        outcome: "success",
        type: "passkey_created",
      },
      {
        id: "event-c",
        occurredAt: now - 1_000,
        outcome: "success",
        type: "passkey_created",
      },
      {
        id: "event-b",
        occurredAt: now - 1_000,
        outcome: "success",
        type: "passkey_created",
      },
      {
        id: "event-old",
        occurredAt: now - 2_000,
        outcome: "failure",
        type: "github_login",
      },
    ])
    const headers = { cookie: `eruoo.session_token=${cookie}` }

    const firstResponse = await fetchAudit(
      "/api/security/audit-events?limit=2",
      headers,
    )
    const firstPage = await firstResponse.json<{
      events: Array<{ id: string; occurredAt: number }>
      nextCursor: string | null
    }>()

    expect(firstResponse.status).toBe(200)
    expect(firstResponse.headers.get("cache-control")).toBe("private, no-store")
    expect(firstPage.events.map(({ id }) => id)).toEqual(["event-c", "event-b"])
    expect(firstPage.events[0]?.occurredAt).toBe(now - 1_000)
    expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)

    const secondResponse = await fetchAudit(
      `/api/security/audit-events?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      headers,
    )
    const secondPage = await secondResponse.json<{
      events: Array<{ id: string }>
      nextCursor: string | null
    }>()

    expect(secondResponse.status).toBe(200)
    expect(secondPage.events.map(({ id }) => id)).toEqual([
      "event-a",
      "event-old",
    ])
    expect(secondPage.nextCursor).toBeNull()
  })

  it("combines type, outcome, and inclusive epoch-millisecond filters", async () => {
    const cookie = await createOwnerSession()
    const now = Date.now()
    await insertEvents([
      {
        id: "matching",
        occurredAt: now - 2_000,
        outcome: "failure",
        type: "passkey_created",
      },
      {
        id: "wrong-outcome",
        occurredAt: now - 2_000,
        outcome: "success",
        type: "passkey_created",
      },
      {
        id: "wrong-type",
        occurredAt: now - 2_000,
        outcome: "failure",
        type: "github_login",
      },
      {
        id: "before-range",
        occurredAt: now - 2_001,
        outcome: "failure",
        type: "passkey_created",
      },
      {
        id: "after-range",
        occurredAt: now - 1_999,
        outcome: "failure",
        type: "passkey_created",
      },
    ])

    const response = await fetchAudit(
      `/api/security/audit-events?type=passkey_created&outcome=failure&from=${now - 2_000}&to=${now - 2_000}`,
      { cookie: `eruoo.session_token=${cookie}` },
    )
    const page = await response.json<{
      events: Array<{ id: string; occurredAt: number }>
      nextCursor: string | null
    }>()

    expect(response.status).toBe(200)
    expect(page).toEqual({
      events: [
        expect.objectContaining({ id: "matching", occurredAt: now - 2_000 }),
      ],
      nextCursor: null,
    })
    expect(typeof page.events[0]?.occurredAt).toBe("number")
  })

  it.each([
    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=1&limit=2",
    "?outcome=unknown",
    "?type=unknown",
    "?from=200&to=100",
    "?unknown=true",
  ])(
    "returns stable validation Problem Details for invalid query %s",
    async (query) => {
      const cookie = await createOwnerSession()
      const response = await fetchAudit(`/api/security/audit-events${query}`, {
        cookie: `eruoo.session_token=${cookie}`,
      })
      const body = await response.json<{
        detail: string
        errors: unknown[]
        requestId: string
        status: number
        title: string
        type: string
      }>()

      expect(response.status).toBe(422)
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(body).toMatchObject({
        detail: "The audit query does not satisfy the operation contract.",
        status: 422,
        title: "Request validation failed",
        type: "https://auth.eruoo.me/problems/validation-failed",
      })
      expect(body.errors.length).toBeGreaterThan(0)
      expect(body.requestId).toEqual(expect.any(String))
      expect(JSON.stringify(body)).not.toContain(query)
    },
  )

  it("binds a cursor to its filters and rejects tampering without echoing it", async () => {
    const cookie = await createOwnerSession()
    const headers = { cookie: `eruoo.session_token=${cookie}` }
    const now = Date.now()
    await insertEvents([
      {
        id: "event-b",
        occurredAt: now - 1_000,
        outcome: "success",
        type: "passkey_created",
      },
      {
        id: "event-a",
        occurredAt: now - 2_000,
        outcome: "success",
        type: "passkey_created",
      },
    ])
    const firstResponse = await fetchAudit(
      "/api/security/audit-events?limit=1&outcome=success",
      headers,
    )
    const firstPage = await firstResponse.json<{ nextCursor: string }>()
    const cursor = firstPage.nextCursor

    const mismatchedResponse = await fetchAudit(
      `/api/security/audit-events?limit=1&outcome=failure&cursor=${encodeURIComponent(cursor)}`,
      headers,
    )
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`
    const tamperedResponse = await fetchAudit(
      `/api/security/audit-events?limit=1&outcome=success&cursor=${encodeURIComponent(tamperedCursor)}`,
      headers,
    )

    for (const [response, rejectedCursor] of [
      [mismatchedResponse, cursor],
      [tamperedResponse, tamperedCursor],
    ] as const) {
      const bodyText = await response.text()

      expect(response.status).toBe(422)
      expect(bodyText).toContain(
        "https://auth.eruoo.me/problems/validation-failed",
      )
      expect(bodyText).not.toContain(rejectedCursor)
    }
  })

  it("returns an IP fingerprint and never the original IP or credential material", async () => {
    const cookie = await createOwnerSession()
    const originalIp = "203.0.113.42"
    await recordAuditEvent(env, originalIp, "request-safe-audit", {
      credentialId: "synthetic-credential-id",
      metadata: { reason: "insufficient_permission", status: 403 },
      outcome: "failure",
      type: "api_key_rejected",
    })

    const response = await fetchAudit("/api/security/audit-events", {
      cookie: `eruoo.session_token=${cookie}`,
    })
    const responseText = await response.text()
    const page = JSON.parse(responseText) as {
      events: Array<{ ipFingerprint: string | null; occurredAt: number }>
    }

    expect(response.status).toBe(200)
    expect(page.events[0]?.ipFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(Number.isInteger(page.events[0]?.occurredAt)).toBe(true)
    expect(responseText).not.toContain(originalIp)
    expect(responseText).not.toContain(env.AUDIT_IP_HASH_SECRET)
    expect(responseText).not.toContain(cookie)
  })

  it("maps corrupt stored values to a stable 500 without exposing them", async () => {
    const cookie = await createOwnerSession()
    const sensitiveInvalidValue = "synthetic-sensitive-invalid-value"
    await env.DB.prepare(
      `INSERT INTO security_audit_events
         (id, type, outcome, occurredAt, requestId)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(
        "corrupt-event",
        "passkey_created",
        sensitiveInvalidValue,
        Date.now(),
        "request-corrupt",
      )
      .run()

    const response = await fetchAudit("/api/security/audit-events", {
      cookie: `eruoo.session_token=${cookie}`,
    })
    const responseText = await response.text()

    expect(response.status).toBe(500)
    expect(responseText).toContain(
      "https://auth.eruoo.me/problems/internal-error",
    )
    expect(responseText).not.toContain(sensitiveInvalidValue)
  })
})

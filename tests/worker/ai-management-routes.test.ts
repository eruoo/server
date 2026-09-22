import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import { problem } from "../../src/worker/http/response"
import { ownerSession } from "./fixtures/session"

let sequence = 0
afterEach(() => vi.restoreAllMocks())
async function call(
  path: string,
  options: {
    body?: unknown
    cookie?: string
    headers?: Record<string, string>
    method?: string
  } = {},
) {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body)
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: options.method ?? (payload === undefined ? "GET" : "POST"),
      headers: {
        "cf-connecting-ip": `ai-management-${++sequence}`,
        "content-type": "application/json",
        origin: env.APP_ORIGIN,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
    env,
    context,
  )
  await waitOnExecutionContext(context)
  return response
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_invocations"),
    env.DB.prepare("DELETE FROM ai_models"),
    env.DB.prepare("DELETE FROM ai_connections"),
    env.DB.prepare("DELETE FROM ai_authorization_sessions"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM apikey"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})

describe("AI management routes", () => {
  it("correlates catalog diagnostics with the local request without changing public errors or audits", async () => {
    const session = await ownerSession()
    const created = await call("/api/ai/connections", {
      body: { name: "Diagnostic", slug: "diagnostic" },
      cookie: session.cookie,
    })
    expect(created.status).toBe(200)
    const { connection } = await created.json<{ connection: { id: string } }>()
    const credentialCiphertext = await encryptAiSecret(
      await parseAiCredentialKeyring(env.AI_CREDENTIAL_KEYS),
      JSON.stringify({
        accessToken: "secret-route-access",
        refreshToken: "secret-route-refresh",
      }),
      {
        connectionId: connection.id,
        environment: env.APP_ORIGIN,
        providerType: "openai-codex",
        purpose: "credential-package",
      },
    )
    await env.DB.prepare(
      "UPDATE ai_connections SET authorizationStatus = ?, credentialCiphertext = ?, credentialExpiresAt = ? WHERE id = ?",
    )
      .bind(
        "connected",
        credentialCiphertext,
        Date.now() + 3_600_000,
        connection.id,
      )
      .run()
    const auditsBefore = (
      await env.DB.prepare(
        "SELECT * FROM security_audit_events ORDER BY id",
      ).all()
    ).results
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
      .bind(new Date(Date.now() - 20 * 60_000).toISOString(), session.id)
      .run()
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("secret-upstream-body", {
        status: 403,
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
          "cf-ray": "abcdef0123456789-SJC",
          "x-request-id": "req_0123456789abcdef",
          "set-cookie": "secret-upstream-cookie",
        },
      }),
    )
    const response = await call(
      `/api/ai/connections/${connection.id}/models/refresh`,
      {
        method: "POST",
        cookie: session.cookie,
        headers: { "x-request-id": "untrusted-client-request" },
      },
    )
    const requestId = response.headers.get("x-request-id")!
    expect(requestId).not.toBe("untrusted-client-request")
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual(
      await problem("ai-upstream-protocol-error", requestId).json(),
    )
    for (const header of ["cf-mitigated", "cf-ray"])
      expect(response.headers.has(header)).toBe(false)
    expect(response.headers.get("set-cookie") ?? "").not.toContain(
      "secret-upstream-cookie",
    )
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        connectionId: connection.id,
        requestId,
        attemptPhase: "initial",
        event: "ai_model_refresh_failed",
        failureKind: "http",
        httpStatus: 403,
        reason: "protocol",
        responseDiagnostics: {
          cfMitigated: "challenge",
          contentType: "html",
          cfRay: "abcdef0123456789-SJC",
          upstreamRequestId: "req_0123456789abcdef",
        },
        bodyFeatureDiagnostics: {
          openAiBlockedSitePageMarkers: false,
          cloudflarePageMarkers: false,
          readOutcome: "complete",
        },
      }),
    )
    expect(fetch).toHaveBeenCalledOnce()
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM security_audit_events ORDER BY id",
        ).all()
      ).results,
    ).toEqual(auditsBefore)
  })

  it("requires an owner session on every management route", async () => {
    // Every registered §6.1 operation is covered, including the
    // authorization and model-refresh entries.
    for (const [method, path] of [
      ["GET", "/api/ai/providers"],
      ["GET", "/api/ai/connections"],
      ["POST", "/api/ai/connections"],
      ["PATCH", "/api/ai/connections/11111111-1111-1111-1111-111111111111"],
      ["DELETE", "/api/ai/connections/11111111-1111-1111-1111-111111111111"],
      [
        "POST",
        "/api/ai/connections/11111111-1111-1111-1111-111111111111/disconnect",
      ],
      [
        "POST",
        "/api/ai/connections/11111111-1111-1111-1111-111111111111/authorizations",
      ],
      ["GET", "/api/ai/authorizations/22222222-2222-2222-2222-222222222222"],
      [
        "POST",
        "/api/ai/authorizations/22222222-2222-2222-2222-222222222222/poll",
      ],
      ["DELETE", "/api/ai/authorizations/22222222-2222-2222-2222-222222222222"],
      [
        "POST",
        "/api/ai/connections/11111111-1111-1111-1111-111111111111/models/refresh",
      ],
      ["GET", "/api/ai/invocations"],
    ] as const) {
      const response = await call(path, {
        method,
        ...(method === "GET" ? {} : { body: {} }),
      })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  it("runs the connection lifecycle after the recent-authentication window", async () => {
    const session = await ownerSession()
    const reauthenticatedAt = new Date(Date.now() - 20 * 60_000).toISOString()
    await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
      .bind(reauthenticatedAt, session.id)
      .run()

    const providers = await call("/api/ai/providers", {
      cookie: session.cookie,
    })
    expect(providers.status).toBe(200)
    const providerBody = await providers.json<{
      providers: { providerType: string }[]
    }>()
    expect(providerBody.providers[0]?.providerType).toBe("openai-codex")

    const created = await call("/api/ai/connections", {
      body: { name: "Main", slug: "codex-main" },
      cookie: session.cookie,
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json<{
      connection: { authorizationStatus: string; id: string; slug: string }
    }>()
    expect(createdBody.connection).toMatchObject({
      authorizationStatus: "never_authorized",
      slug: "codex-main",
    })
    const connectionId = createdBody.connection.id

    // The slug is unique: a second create with the same slug is rejected.
    const duplicate = await call("/api/ai/connections", {
      body: { name: "Other", slug: "codex-main" },
      cookie: session.cookie,
    })
    expect(duplicate.status).toBe(422)

    const listed = await call("/api/ai/connections", { cookie: session.cookie })
    const listedBody = await listed.json<{
      connections: { id: string; models: unknown[] }[]
    }>()
    expect(listedBody.connections.map((connection) => connection.id)).toEqual([
      connectionId,
    ])
    expect(listedBody.connections[0]?.models).toEqual([])

    const renamed = await call(`/api/ai/connections/${connectionId}`, {
      body: { name: "Renamed" },
      cookie: session.cookie,
      method: "PATCH",
    })
    expect(renamed.status).toBe(200)
    const renamedBody = await renamed.json<{ connection: { name: string } }>()
    expect(renamedBody.connection.name).toBe("Renamed")

    const disabled = await call(`/api/ai/connections/${connectionId}`, {
      body: { enabled: false },
      cookie: session.cookie,
      method: "PATCH",
    })
    expect(disabled.status).toBe(200)
    const disabledBody = await disabled.json<{
      connection: { enabled: boolean }
    }>()
    expect(disabledBody.connection.enabled).toBe(false)

    const missing = await call(
      "/api/ai/connections/99999999-9999-4999-8999-999999999999",
      { body: { name: "x" }, cookie: session.cookie, method: "PATCH" },
    )
    expect(missing.status).toBe(404)

    const disconnected = await call(
      `/api/ai/connections/${connectionId}/disconnect`,
      { cookie: session.cookie, method: "POST" },
    )
    expect(disconnected.status).toBe(200)

    const deleted = await call(`/api/ai/connections/${connectionId}`, {
      cookie: session.cookie,
      method: "DELETE",
    })
    expect(deleted.status).toBe(200)

    const audits = await env.DB.prepare(
      "SELECT type, outcome FROM security_audit_events",
    ).all<{ outcome: string; type: string }>()
    // Audit rows are written asynchronously; compare the set, not the order.
    expect(audits.results.map((row) => row.type).sort()).toEqual(
      [
        "ai_connection_created",
        "ai_connection_updated",
        "ai_connection_updated",
        "ai_connection_disconnected",
        "ai_connection_deleted",
      ].sort(),
    )
    expect(audits.results.every((row) => row.outcome === "success")).toBe(true)
    expect(
      await env.DB.prepare("SELECT reauthenticatedAt FROM session WHERE id=?")
        .bind(session.id)
        .first("reauthenticatedAt"),
    ).toBe(reauthenticatedAt)
  })

  it("starts, polls, and cancels authorization without recent authentication", async () => {
    const session = await ownerSession()
    await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
      .bind(new Date(Date.now() - 20 * 60_000).toISOString(), session.id)
      .run()
    const created = await call("/api/ai/connections", {
      body: { name: "Main", slug: "codex-main" },
      cookie: session.cookie,
    })
    expect(created.status).toBe(200)
    const { connection } = await created.json<{ connection: { id: string } }>()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === "/api/accounts/deviceauth/usercode") {
          return Promise.resolve(
            Response.json({
              device_auth_id: "device-auth-1",
              interval: "5",
              user_code: "WDJB-MJHT",
            }),
          )
        }
        if (url.pathname === "/api/accounts/deviceauth/token") {
          return Promise.resolve(Response.json({}, { status: 404 }))
        }
        throw new Error(`Unexpected upstream request: ${request.url}`)
      })
    const started = await call(
      `/api/ai/connections/${connection.id}/authorizations`,
      { cookie: session.cookie, method: "POST" },
    )
    expect(started.status).toBe(200)
    const { authorizationId } = await started.json<{
      authorizationId: string
    }>()
    await env.DB.prepare(
      "UPDATE ai_authorization_sessions SET nextPollAt=? WHERE id=?",
    )
      .bind(Date.now() - 1, authorizationId)
      .run()
    const polled = await call(
      `/api/ai/authorizations/${authorizationId}/poll`,
      {
        cookie: session.cookie,
        method: "POST",
      },
    )
    expect(polled.status).toBe(200)
    expect(await polled.json()).toMatchObject({ status: "pending" })
    const cancelled = await call(`/api/ai/authorizations/${authorizationId}`, {
      cookie: session.cookie,
      method: "DELETE",
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each(["revoked", "expired"] as const)(
    "rejects every mutation with a %s session despite its cached identity",
    async (state) => {
      const session = await ownerSession()
      const identity = await call("/api/auth/get-session", {
        cookie: session.cookie,
      })
      const cachedCookies = identity.headers
        .getSetCookie()
        .filter((cookie) => cookie.startsWith("eruoo.session_data="))
        .map((cookie) => cookie.split(";")[0])
      expect(cachedCookies).toHaveLength(1)
      const cookie = [session.cookie, ...cachedCookies].join("; ")
      if (state === "revoked") {
        await env.DB.prepare("DELETE FROM session WHERE id=?")
          .bind(session.id)
          .run()
      } else {
        await env.DB.prepare("UPDATE session SET expiresAt=? WHERE id=?")
          .bind(new Date(Date.now() - 1_000).toISOString(), session.id)
          .run()
      }
      const fetch = vi.spyOn(globalThis, "fetch")
      const connectionId = "11111111-1111-4111-8111-111111111111"
      const authorizationId = "22222222-2222-4222-8222-222222222222"
      for (const [method, path, body] of [
        ["POST", "/api/ai/connections", { name: "Rejected", slug: "rejected" }],
        ["PATCH", `/api/ai/connections/${connectionId}`, { name: "Rejected" }],
        ["DELETE", `/api/ai/connections/${connectionId}`, undefined],
        ["POST", `/api/ai/connections/${connectionId}/disconnect`, undefined],
        [
          "POST",
          `/api/ai/connections/${connectionId}/authorizations`,
          undefined,
        ],
        ["POST", `/api/ai/authorizations/${authorizationId}/poll`, undefined],
        ["DELETE", `/api/ai/authorizations/${authorizationId}`, undefined],
        [
          "POST",
          `/api/ai/connections/${connectionId}/models/refresh`,
          undefined,
        ],
      ] as const) {
        const response = await call(path, { method, body, cookie })
        expect(response.status, `${method} ${path}`).toBe(401)
        expect(await response.json()).toMatchObject({
          type: expect.stringContaining("/invalid-credential"),
        })
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM ai_connections",
        ).first("count"),
      ).toBe(0)
    },
  )

  it("requires the exact Origin and a bounded body on mutations", async () => {
    const session = await ownerSession()
    const context = createExecutionContext()
    const noOrigin = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/api/ai/connections`, {
        body: JSON.stringify({ name: "Main", slug: "codex-main" }),
        headers: {
          "cf-connecting-ip": `ai-management-${++sequence}`,
          "content-type": "application/json",
          cookie: session.cookie,
        },
        method: "POST",
      }),
      env,
      context,
    )
    await waitOnExecutionContext(context)
    expect(noOrigin.status).toBe(403)

    const crossOrigin = await call("/api/ai/connections", {
      body: { name: "Main", slug: "codex-main" },
      cookie: session.cookie,
      headers: { origin: "https://sibling.eruoo.me" },
    })
    expect(crossOrigin.status).toBe(403)

    // The general 1 MiB management bound applies to this entry.
    const oversized = await call("/api/ai/connections", {
      body: { name: "x".repeat(1_048_576), slug: "codex-main" },
      cookie: session.cookie,
    })
    expect(oversized.status).toBe(413)
  })

  it("validates inputs and lists the invocation history", async () => {
    const session = await ownerSession()
    const invalidSlug = await call("/api/ai/connections", {
      body: { name: "Main", slug: "Not A Slug" },
      cookie: session.cookie,
    })
    expect(invalidSlug.status).toBe(422)
    const unknownField = await call("/api/ai/connections", {
      body: { name: "Main", slug: "codex-main", providerType: "other" },
      cookie: session.cookie,
    })
    expect(unknownField.status).toBe(422)

    const history = await call("/api/ai/invocations", {
      cookie: session.cookie,
    })
    expect(history.status).toBe(200)
    const page = await history.json<{
      nextCursor: unknown
      records: unknown[]
    }>()
    expect(page.records).toEqual([])
    expect(page.nextCursor).toBeNull()

    const badLimit = await call("/api/ai/invocations?limit=0", {
      cookie: session.cookie,
    })
    expect(badLimit.status).toBe(422)
    const badCursor = await call(
      "/api/ai/invocations?beforeStartedAt=abc&beforeRequestId=not-a-uuid",
      { cookie: session.cookie },
    )
    expect(badCursor.status).toBe(422)
  })
})

it("returns a masked upstream account and never the raw identifier", async () => {
  const session = await ownerSession()
  const created = await call("/api/ai/connections", {
    body: { name: "Masked", slug: "codex-masked" },
    cookie: session.cookie,
  })
  expect(created.status).toBe(200)
  const connectionId = (await created.json<{ connection: { id: string } }>())
    .connection.id

  // §5.2: the management API returns the masked account, not the raw one.
  await env.DB.prepare(
    `UPDATE "ai_connections" SET "upstreamAccountId" = ?1 WHERE "id" = ?2`,
  )
    .bind("account-abcdefgh", connectionId)
    .run()

  const listed = await call("/api/ai/connections", { cookie: session.cookie })
  expect(listed.status).toBe(200)
  const body = await listed.json<{
    connections: { id: string; upstreamAccount: string }[]
  }>()
  const connection = body.connections.find(
    (candidate) => candidate.id === connectionId,
  )
  expect(connection?.upstreamAccount).toBe("ac…efgh")
  expect(JSON.stringify(body)).not.toContain("account-abcdefgh")
})

import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import worker from "../../src/worker"
import { ownerSession } from "./fixtures/session"

let sequence = 0
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

  it("runs the connection lifecycle with audits and model snapshots", async () => {
    const session = await ownerSession()

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
  })

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

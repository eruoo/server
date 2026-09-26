import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import { instrumentDatabase, ownerSession } from "./fixtures/session"

let sequence = 0
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
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

    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM apikey"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})

describe("AI management routes", () => {
  it.each([false, true])(
    "bounds every mutation body before Session inspection (authenticated: %s)",
    async (authenticated) => {
      const cookie = authenticated ? (await ownerSession()).cookie : undefined
      const id = crypto.randomUUID()
      const bytes = new TextEncoder().encode(
        JSON.stringify({ padding: "x".repeat(2 * 1_048_576) }),
      )
      const upstream = vi.spyOn(globalThis, "fetch")
      let queries = 0
      const database = instrumentDatabase(env.DB, () => {
        queries++
      })
      for (const [method, path] of [
        ["POST", "/api/ai/connections"],
        ["PATCH", `/api/ai/connections/${id}`],
        ["DELETE", `/api/ai/connections/${id}`],
        ["PUT", `/api/ai/connections/${id}/credential`],
        ["POST", `/api/ai/connections/${id}/disconnect`],
        ["POST", `/api/ai/connections/${id}/models/refresh`],
      ]) {
        let consumed = 0
        let cancelled = false
        const context = createExecutionContext()
        const request = new Request(env.APP_ORIGIN + path, {
          method,
          headers: {
            "content-type": "application/json",
            origin: env.APP_ORIGIN,
            "cf-connecting-ip": `ai-body-${++sequence}`,
            ...(cookie ? { cookie } : {}),
          },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (consumed === bytes.length) {
                controller.close()
                return
              }
              const chunk = bytes.slice(consumed, consumed + 65_536)
              consumed += chunk.length
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
            },
          }),
        })
        expect(request.headers.has("content-length")).toBe(false)
        const response = await worker.fetch(
          request,
          { ...env, DB: database },
          context,
        )
        await waitOnExecutionContext(context)
        expect(response.status, `${method} ${path}`).toBe(413)
        expect(consumed).toBeLessThan(bytes.length)
        expect(cancelled).toBe(true)
      }
      expect(queries).toBe(0)
      expect(upstream).not.toHaveBeenCalled()
    },
  )

  it("shares each mutation's IP limit across arbitrary connection IDs", async () => {
    const ip = `2001:db8::${crypto.randomUUID().slice(0, 4)}`
    for (const [method, suffix] of [
      ["PATCH", ""],
      ["DELETE", ""],
      ["PUT", "/credential"],
      ["POST", "/disconnect"],
      ["POST", "/models/refresh"],
    ]) {
      for (let attempt = 0; attempt < 61; attempt++) {
        const context = createExecutionContext()
        const response = await worker.fetch(
          new Request(
            `${env.APP_ORIGIN}/api/ai/connections/${crypto.randomUUID()}${suffix}`,
            {
              method,
              headers: {
                "content-type": "application/json",
                origin: env.APP_ORIGIN,
                "cf-connecting-ip": ip,
              },
            },
          ),
          env,
          context,
        )
        await waitOnExecutionContext(context)
        expect(response.status, `${method} ${suffix} attempt ${attempt}`).toBe(
          attempt < 60 ? 401 : 429,
        )
      }
    }
  })

  it("bounds all management reads including Session lookup and discards late cookies", async () => {
    const session = await ownerSession()
    let release!: () => void
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const database = instrumentDatabase(env.DB, async () => {
      enter()
      await blocked
    })
    const paths = [
      "/api/ai/providers",
      "/api/ai/connections",
      "/api/ai/invocations",
    ]
    const contexts = paths.map(() => createExecutionContext())
    const observed: number[] = []
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const pending = paths.map((path, index) =>
      Promise.resolve(
        worker.fetch(
          new Request(env.APP_ORIGIN + path, {
            headers: { cookie: session.cookie },
          }),
          { ...env, DB: database },
          contexts[index],
        ),
      ).then((response) => {
        observed.push(response.status)
        return response
      }),
    )
    try {
      await entered
      await vi.advanceTimersByTimeAsync(5_001)
      expect(observed).toEqual([504, 504, 504])
    } finally {
      release()
      const responses = await Promise.all(pending)
      await Promise.all(
        contexts.map((context) => waitOnExecutionContext(context)),
      )
      for (const response of responses) {
        expect(response.status).toBe(504)
        expect(response.headers.has("set-cookie")).toBe(false)
      }
    }
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
        "PUT",
        "/api/ai/connections/11111111-1111-1111-1111-111111111111/credential",
      ],
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
    expect(providerBody.providers[0]?.providerType).toBe("deepseek")

    const created = await call("/api/ai/connections", {
      body: { name: "Main" },
      cookie: session.cookie,
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json<{
      connection: { authorizationStatus: string; id: string; name: string }
    }>()
    expect(createdBody.connection).toMatchObject({
      authorizationStatus: "never_authorized",
      name: "Main",
    })
    const connectionId = createdBody.connection.id

    const saved = await call(`/api/ai/connections/${connectionId}/credential`, {
      method: "PUT",
      cookie: session.cookie,
      body: { apiKey: "synthetic-deepseek-key", expectedVersion: 0 },
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ saved: true })
    const connectionList = await call("/api/ai/connections", {
      cookie: session.cookie,
    })
    const publicText = await connectionList.text()
    expect(publicText).not.toContain("synthetic-deepseek-key")
    expect(publicText).not.toContain("credentialCiphertext")
    const event = await env.DB.prepare(
      "SELECT metadata FROM security_audit_events WHERE type='ai_credential_saved'",
    ).first<{ metadata: string }>()
    expect(event).not.toBeNull()
    expect(event?.metadata).not.toContain("synthetic-deepseek-key")

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
        "ai_credential_saved",
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
      for (const [method, path, body] of [
        ["POST", "/api/ai/connections", { name: "Rejected" }],
        ["PATCH", `/api/ai/connections/${connectionId}`, { name: "Rejected" }],
        ["DELETE", `/api/ai/connections/${connectionId}`, undefined],
        ["POST", `/api/ai/connections/${connectionId}/disconnect`, undefined],
        [
          "PUT",
          `/api/ai/connections/${connectionId}/credential`,
          { apiKey: "synthetic", expectedVersion: 0 },
        ],
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
        body: JSON.stringify({ name: "Main" }),
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
      body: { name: "Main" },
      cookie: session.cookie,
      headers: { origin: "https://sibling.eruoo.me" },
    })
    expect(crossOrigin.status).toBe(403)

    // The general 1 MiB management bound applies to this entry.
    const oversized = await call("/api/ai/connections", {
      body: { name: "x".repeat(1_048_576) },
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
      body: { name: "Main", providerType: "other" },
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

it("allows model discovery with an older valid session but protects caller-key grants", async () => {
  const session = await ownerSession()
  const created = await call("/api/ai/connections", {
    cookie: session.cookie,
    body: { name: "Session acceptance" },
  })
  expect(created.status).toBe(200)
  const { connection } = await created.json<{ connection: { id: string } }>()
  const saved = await call(`/api/ai/connections/${connection.id}/credential`, {
    cookie: session.cookie,
    method: "PUT",
    body: { apiKey: "synthetic-session-test", expectedVersion: 0 },
  })
  expect(saved.status).toBe(200)
  const oldAuth = new Date(Date.now() - 20 * 60_000).toISOString()
  await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
    .bind(oldAuth, session.id)
    .run()
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: [{ id: "deepseek-flash", object: "model", owned_by: "deepseek" }],
    }),
  )
  const discovered = await call(
    `/api/ai/connections/${connection.id}/models/refresh`,
    { cookie: session.cookie, method: "POST" },
  )
  expect(discovered.status).toBe(200)
  expect(await discovered.json()).toEqual({
    modelCount: 1,
    status: "committed",
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  const body = {
    name: "session-boundary",
    purpose: "ai",
    connectionId: connection.id,
    modelIds: ["deepseek-flash"],
  }
  const staleCreate = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body,
  })
  expect(staleCreate.status).toBe(403)
  expect(await staleCreate.json()).toMatchObject({
    type: "https://auth.eruoo.me/problems/recent-authentication-required",
  })
  await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
    .bind(new Date().toISOString(), session.id)
    .run()
  const freshCreate = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body,
  })
  expect(freshCreate.status).toBe(200)
  const key = await freshCreate.json<{ id: string }>()
  const before = await env.DB.prepare(
    "SELECT permissions FROM apikey WHERE id=?",
  )
    .bind(key.id)
    .first()
  await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
    .bind(oldAuth, session.id)
    .run()
  const staleUpdate = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    body: {
      configId: "ai",
      keyId: key.id,
      name: body.name,
      connectionId: connection.id,
      modelIds: [],
    },
  })
  expect(staleUpdate.status).toBe(403)
  expect(await staleUpdate.json()).toMatchObject({
    type: "https://auth.eruoo.me/problems/recent-authentication-required",
  })
  expect(
    await env.DB.prepare("SELECT permissions FROM apikey WHERE id=?")
      .bind(key.id)
      .first(),
  ).toEqual(before)
})

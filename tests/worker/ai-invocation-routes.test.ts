import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import {
  parseAiCredentialKeyring,
  encryptAiSecret,
} from "../../src/worker/ai/credential-cipher"
import { readAiInvocation } from "../../src/worker/ai/invocations"
import { instrumentDatabase, ownerSession } from "./fixtures/session"

const connectionId = "11111111-1111-1111-1111-111111111111"
const upstreamModelId = "gpt-test"
const externalModelId = "gpt-test"
const reasoningUpstreamModelId = "gpt-reasoning"
const reasoningExternalModelId = `${reasoningUpstreamModelId}`

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseUpstream(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" }, status: 200 },
  )
}

const completedFrames = [
  sseFrame("response.output_item.done", {
    item: { content: [], id: "item_1", role: "assistant", type: "message" },
    output_index: 0,
    type: "response.output_item.done",
  }),
  sseFrame("response.completed", {
    response: {
      output: [
        { content: [], id: "item_1", role: "assistant", type: "message" },
      ],
      status: "completed",
      usage: { total_tokens: 5 },
    },
    type: "response.completed",
  }),
]

let sequence = 0
async function call(
  path: string,
  options: {
    body?: unknown
    cookie?: string
    headers?: Record<string, string>
    method?: string
    rawBody?: string
  } = {},
) {
  const payload =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body))
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: options.method ?? (payload === undefined ? "GET" : "POST"),
      headers: {
        "cf-connecting-ip": `ai-route-${++sequence}`,
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

/** Seeds a connected connection with a usable credential and catalog models. */
async function seedCatalog(): Promise<void> {
  const now = Date.now()
  // Encrypted with the same local keyring the runtime reads, so the
  // credential stage can actually unlock it.
  const keyring = await parseAiCredentialKeyring(env.AI_CREDENTIAL_KEYS)
  const ciphertext = await encryptAiSecret(
    keyring,
    JSON.stringify({
      kind: "api-key",
      apiKey: "access-token-1",
    }),
    {
      connectionId,
      environment: env.APP_ORIGIN,
      providerType: "deepseek",
      purpose: "credential-package",
    },
  )
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "ai_connections" ("id","slug","name","providerType","enabled","authorizationStatus","credentialVersion","credentialCiphertext","createdAt","updatedAt")
       VALUES (?,?,?,?,1,'connected',1,?,?,?)`,
    ).bind(
      connectionId,
      "codex-main",
      "Main",
      "deepseek",
      ciphertext,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES (?,?,NULL,'{"supportedInApi":true,"reasoningEfforts":["max"]}',1,?)`,
    ).bind(connectionId, upstreamModelId, now),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES (?,?,NULL,'{"supportedInApi":true,"reasoningEfforts":["max"]}',1,?)`,
    ).bind(connectionId, "other-model", now),
    // One model with declared reasoning efforts, so a confirmed capability can
    // be told apart from an unconfirmed one.
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES (?,?,NULL,?,1,?)`,
    ).bind(
      connectionId,
      reasoningUpstreamModelId,
      JSON.stringify({
        reasoningEfforts: ["low", "high", "max"],
        supportedInApi: true,
        visibility: "list",
      }),
      now,
    ),
  ])
}

/** Counts the live reservations, which is what both quotas are read from. */
async function reservedRowCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM "ai_invocations" WHERE "status" = 'reserved'`,
  ).first<{ count: number }>()
  return row?.count ?? 0
}

/** Creates an ai-profile key through the real gateway. */
async function createAiKey(
  modelIds: string[],
  cookie?: string,
): Promise<string> {
  const sessionCookie = cookie ?? (await ownerSession()).cookie
  const response = await call("/api/auth/api-key/create", {
    body: { connectionId, modelIds, name: "ai route probe", purpose: "ai" },
    cookie: sessionCookie,
  })
  expect(response.status).toBe(200)
  const created = await response.json<{ key: string }>()
  return created.key
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
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
  await seedCatalog()
})

describe("AI invocation routes", () => {
  it("bounds model listing while API key verification is pending", async () => {
    const key = await createAiKey([externalModelId])
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
    const context = createExecutionContext()
    let status: number | undefined
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const pending = Promise.resolve(
      worker.fetch(
        new Request(`${env.APP_ORIGIN}/api/ai/models`, {
          headers: {
            "x-api-key": key,
            "cf-connecting-ip": `ai-read-${++sequence}`,
          },
        }),
        { ...env, DB: database },
        context,
      ),
    ).then((response) => {
      status = response.status
      return response
    })
    try {
      await entered
      await vi.advanceTimersByTimeAsync(5_001)
      expect(status).toBe(504)
    } finally {
      release()
      await pending
      await waitOnExecutionContext(context)
      vi.useRealTimers()
    }
  })

  it.each([
    ["connection lookup", 'FROM "ai_connections"'],
    ["model lookup", 'FROM "ai_models"'],
    ["identity write", 'SET "connectionId" = ?2'],
    ["reservation cleanup", 'DELETE FROM "ai_invocations"'],
    ["terminal write", 'SET "status" = ?2'],
  ])(
    "returns at the total deadline during %s and observes late work",
    async (stage, query) => {
      const key = await createAiKey([externalModelId])
      let release!: () => void
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const queriesAfterBlocking: string[] = []
      let hasEntered = false
      const database = instrumentDatabase(env.DB, async (sql) => {
        if (hasEntered) queriesAfterBlocking.push(sql)
        if (sql.includes(query)) {
          hasEntered = true
          enter()
          await blocked
        }
      })
      const upstream = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => sseUpstream(completedFrames))
      const decrypt = vi.spyOn(crypto.subtle, "decrypt")
      const context = createExecutionContext()
      let response: Response | undefined
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const pending = Promise.resolve(
        worker.fetch(
          new Request(`${env.APP_ORIGIN}/api/ai/responses`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key,
              "cf-connecting-ip": `ai-deadline-${++sequence}`,
            },
            body: JSON.stringify(
              stage === "reservation cleanup"
                ? {}
                : { model: externalModelId, input: "hi", stream: false },
            ),
          }),
          { ...env, DB: database },
          context,
        ),
      ).then((value) => {
        response = value
        return value
      })
      try {
        await entered
        await vi.advanceTimersByTimeAsync(300_001)
        expect(response?.status).toBe(504)
        const timedOutBody = await response?.clone().text()
        release()
        await pending
        await waitOnExecutionContext(context)
        expect(await response?.text()).toBe(timedOutBody)
        expect(upstream).toHaveBeenCalledTimes(
          stage === "terminal write" ? 1 : 0,
        )
        expect(await reservedRowCount()).toBe(0)
        expect(decrypt).toHaveBeenCalledTimes(
          stage === "terminal write" ? 1 : 0,
        )
        const requestId = response!.headers.get("x-request-id")!
        const record = await readAiInvocation(env.DB, requestId, Date.now())
        expect(record?.status).toBe(
          stage === "terminal write" ? "succeeded" : undefined,
        )
        expect(
          queriesAfterBlocking.some((sql) => sql.includes('FROM "ai_models"')),
        ).toBe(false)
      } finally {
        release()
        await pending
        await waitOnExecutionContext(context)
        vi.useRealTimers()
        upstream.mockRestore()
        decrypt.mockRestore()
      }
    },
  )

  it("lists only the models the key was granted", async () => {
    const key = await createAiKey([externalModelId])
    const response = await call("/api/ai/models", {
      headers: { "x-api-key": key },
    })
    expect(response.status).toBe(200)
    const body = await response.json<{ models: { id: string }[] }>()
    expect(body.models.map((model) => model.id)).toEqual([externalModelId])
  })

  it("routes a native model only through the key's bound connection", async () => {
    const otherId = "99999999-9999-9999-9999-999999999999"
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO ai_connections SELECT ?1,?1,name,providerType,enabled,authorizationStatus,credentialVersion,permissionVersion,credentialCiphertext,createdAt,updatedAt FROM ai_connections WHERE id=?2`,
      ).bind(otherId, connectionId),
      env.DB.prepare(
        `INSERT INTO ai_models SELECT ?,upstreamModelId,displayName,capabilities,snapshotCredentialVersion,discoveredAt FROM ai_models WHERE connectionId=?`,
      ).bind(otherId, connectionId),
    ])
    const key = await createAiKey([externalModelId])
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseUpstream(completedFrames))
    try {
      const response = await call("/api/ai/responses", {
        body: { input: "hi", model: externalModelId, stream: false },
        headers: { "x-api-key": key },
      })
      expect(response.status).toBe(200)
      await response.text()
      expect(
        await env.DB.prepare("SELECT connectionId FROM ai_invocations").first(),
      ).toEqual({ connectionId })
      await env.DB.prepare("UPDATE ai_connections SET enabled=0 WHERE id=?")
        .bind(connectionId)
        .run()
      const refused = await call("/api/ai/responses", {
        body: { input: "hi", model: externalModelId },
        headers: { "x-api-key": key },
      })
      expect(refused.status).toBe(403)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      fetch.mockRestore()
    }
  })

  it("rejects session and bearer carriers on the API-key surface", async () => {
    const session = await ownerSession()
    const withSession = await call("/api/ai/models", { cookie: session.cookie })
    expect(withSession.status).toBe(401)
    const withBearer = await call("/api/ai/models", {
      headers: { authorization: "Bearer token" },
    })
    expect(withBearer.status).toBe(401)
    const missing = await call("/api/ai/models")
    expect(missing.status).toBe(401)
  })

  it("rejects an unknown key and a key without the model grant", async () => {
    const unknown = await call("/api/ai/models", {
      headers: { "x-api-key": "eruoo_not_a_key" },
    })
    expect(unknown.status).toBe(401)

    // A key granted a different model cannot invoke this one.
    const key = await createAiKey(["other-model"])
    const response = await call("/api/ai/responses", {
      body: { input: "hi", model: externalModelId },
      headers: { "x-api-key": key },
    })
    expect(response.status).toBe(403)
    const problem = await response.json<{ type: string }>()
    expect(problem.type).toContain("permission-denied")
  })

  it("rejects an unknown model and an invalid body", async () => {
    const key = await createAiKey([externalModelId])
    const unknownModel = await call("/api/ai/responses", {
      body: { input: "hi", model: "not-in-catalog" },
      headers: { "x-api-key": key },
    })
    expect(unknownModel.status).toBe(403)
    const invalid = await call("/api/ai/responses", {
      body: { model: externalModelId, temperature: 0.5 },
      headers: { "x-api-key": key },
    })
    expect(invalid.status).toBe(422)
  })

  it("streams the upstream response and commits the invocation", async () => {
    const key = await createAiKey([externalModelId])
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseUpstream(completedFrames))
    try {
      const response = await call("/api/ai/responses", {
        body: { input: "hi", model: externalModelId },
        headers: { "x-api-key": key },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      const text = await response.text()
      expect(text).toContain("event: response.completed")
    } finally {
      fetchMock.mockRestore()
    }

    // The invocation row is committed with the terminal outcome and the
    // identity that was resolved and authorized before the call started.
    const rows = await env.DB.prepare(
      "SELECT status, errorCode, connectionId, upstreamModelId FROM ai_invocations",
    ).all<{
      connectionId: string | null
      errorCode: string | null
      status: string
      upstreamModelId: string | null
    }>()
    expect(rows.results).toEqual([
      {
        connectionId,
        errorCode: null,
        status: "succeeded",
        upstreamModelId,
      },
    ])
  })

  it("accepts a reasoning effort the model catalog declares", async () => {
    const key = await createAiKey([reasoningExternalModelId])
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => sseUpstream(completedFrames))
    try {
      const response = await call("/api/ai/responses", {
        body: {
          input: "hi",
          model: reasoningExternalModelId,
          reasoning: { effort: "high" },
        },
        headers: { "x-api-key": key },
      })
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("refuses a reasoning effort the model catalog does not declare", async () => {
    // `gpt-test` records no reasoning efforts: unconfirmed capability is not
    // support, so no effort is accepted for it.
    const key = await createAiKey([externalModelId])
    const fetchMock = vi.spyOn(globalThis, "fetch")
    try {
      const response = await call("/api/ai/responses", {
        body: {
          input: "hi",
          model: externalModelId,
          reasoning: { effort: "high" },
        },
        headers: { "x-api-key": key },
      })
      expect(response.status).toBe(422)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
    }
    expect(await reservedRowCount()).toBe(0)
  })

  it("refuses structured output the catalog cannot confirm", async () => {
    // Even the model with declared reasoning efforts carries no confirmation
    // field for structured output, so the request is refused before the call.
    const key = await createAiKey([reasoningExternalModelId])
    const fetchMock = vi.spyOn(globalThis, "fetch")
    try {
      const response = await call("/api/ai/responses", {
        body: {
          input: "hi",
          model: reasoningExternalModelId,
          text: {
            format: {
              name: "answer",
              schema: { properties: { answer: { type: "string" } } },
              type: "json_schema",
            },
          },
        },
        headers: { "x-api-key": key },
      })
      expect(response.status).toBe(422)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
    }
    expect(await reservedRowCount()).toBe(0)
  })

  it("releases the slot and calls no upstream when the request never starts", async () => {
    const session = await ownerSession()
    const key = await createAiKey([externalModelId], session.cookie)
    const ungrantedKey = await createAiKey(["other-model"], session.cookie)
    const cases: {
      body?: unknown
      expected: number
      key: string
      rawBody?: string
    }[] = [
      { expected: 400, key, rawBody: "{not json" },
      { expected: 413, key, rawBody: `"${"x".repeat(9 * 1_048_576)}"` },
      {
        // A body that is otherwise valid: the 422 comes from the unknown
        // field, not from a missing required one.
        body: { input: "hi", model: externalModelId, temperature: 0.5 },
        expected: 422,
        key,
      },
      {
        body: { input: "hi", model: "not-in-catalog" },
        expected: 403,
        key,
      },
      {
        body: { input: "hi", model: externalModelId },
        expected: 403,
        key: ungrantedKey,
      },
    ]
    const fetchMock = vi.spyOn(globalThis, "fetch")
    try {
      for (const testCase of cases) {
        const response = await call("/api/ai/responses", {
          body: testCase.body,
          headers: { "x-api-key": testCase.key },
          rawBody: testCase.rawBody,
        })
        expect(response.status).toBe(testCase.expected)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(await reservedRowCount()).toBe(0)
      }
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("answers concurrency-exceeded without reading an oversize body", async () => {
    const key = await createAiKey([externalModelId])
    const now = Date.now()
    const insert = (requestId: string, apiKeyId: string) =>
      env.DB.prepare(
        `INSERT INTO "ai_invocations" ("requestId","apiKeyId","connectionId","upstreamModelId","startedAt","deadlineAt","leaseExpiresAt","status")
         VALUES (?,?,?,?,?,?,?,'reserved')`,
      )
        .bind(
          requestId,
          apiKeyId,
          connectionId,
          upstreamModelId,
          now,
          now + 60_000,
          now + 60_000,
        )
        .run()
    await insert("99999999-9999-4999-8999-999999999999", "other-key-1")
    await insert("99999999-9999-4999-8999-999999999998", "other-key-2")

    // The body is over the 8 MiB budget: a route that read it before deciding
    // admission would answer 413 instead of the quota answer.
    const response = await call("/api/ai/responses", {
      headers: { "x-api-key": key },
      rawBody: `"${"x".repeat(9 * 1_048_576)}"`,
    })
    expect(response.status).toBe(429)
    expect(await reservedRowCount()).toBe(2)
  })

  it("answers concurrency-exceeded when the only slot is taken", async () => {
    const key = await createAiKey([externalModelId])
    const now = Date.now()
    const insert = (requestId: string, apiKeyId: string) =>
      env.DB.prepare(
        `INSERT INTO "ai_invocations" ("requestId","apiKeyId","connectionId","upstreamModelId","startedAt","deadlineAt","leaseExpiresAt","status")
         VALUES (?,?,?,?,?,?,?,'reserved')`,
      )
        .bind(
          requestId,
          apiKeyId,
          connectionId,
          upstreamModelId,
          now,
          now + 60_000,
          now + 60_000,
        )
        .run()
    // Two live reservations fill the service-wide limit of two.
    await insert("99999999-9999-4999-8999-999999999999", "other-key-1")
    await insert("99999999-9999-4999-8999-999999999998", "other-key-2")

    const response = await call("/api/ai/responses", {
      body: { input: "hi", model: externalModelId },
      headers: { "x-api-key": key },
    })
    expect(response.status).toBe(429)
    const problem = await response.json<{ type: string }>()
    expect(problem.type).toContain("ai-concurrency-exceeded")
    expect(response.headers.get("retry-after")).toBe("1")
    const row = await readAiInvocation(
      env.DB,
      "99999999-9999-4999-8999-999999999999",
      Date.now(),
    )
    expect(row?.status).toBe("reserved")
  })
})

it("returns structured JSON through the authenticated route with default max", async () => {
  await env.DB.prepare(
    "UPDATE ai_models SET capabilities=? WHERE connectionId=? AND upstreamModelId=?",
  )
    .bind(
      JSON.stringify({
        supportedInApi: true,
        reasoningEfforts: ["max"],
        structuredOutput: true,
      }),
      connectionId,
      upstreamModelId,
    )
    .run()
  const key = await createAiKey([upstreamModelId])
  const format = {
    type: "json_schema",
    name: "echo_result",
    schema: {
      type: "object",
      properties: { echo: { type: "string" } },
      required: ["echo"],
      additionalProperties: false,
    },
  }
  const upstreamBodies: unknown[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return sseUpstream([
        sseFrame("response.completed", {
          type: "response.completed",
          response: {
            status: "completed",
            reasoning: { effort: "max" },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: '{"echo":"hello"}' }],
              },
            ],
            usage: { total_tokens: 12 },
          },
        }),
      ])
    })
  try {
    const response = await call("/api/ai/responses", {
      headers: { "x-api-key": key },
      body: {
        model: upstreamModelId,
        input: "Return JSON with echo=hello",
        text: { format },
        stream: false,
      },
    })
    expect(response.status).toBe(200)
    const body = await response.json<{
      status: string
      output: { content: { text: string }[] }[]
    }>()
    expect(body.status).toBe("completed")
    expect(JSON.parse(body.output[0].content[0].text)).toEqual({
      echo: "hello",
    })
    expect(upstreamBodies).toEqual([
      expect.objectContaining({
        model: upstreamModelId,
        reasoning: { effort: "max" },
        text: { format },
      }),
    ])
    expect(
      await env.DB.prepare("SELECT status, usage FROM ai_invocations").first(),
    ).toEqual({ status: "succeeded", usage: '{"total_tokens":12}' })
  } finally {
    fetch.mockRestore()
  }
})

it("completes a two-request tool round trip with returned reasoning history and default max", async () => {
  await env.DB.prepare(
    "UPDATE ai_models SET capabilities=? WHERE connectionId=? AND upstreamModelId=?",
  )
    .bind(
      JSON.stringify({
        supportedInApi: true,
        reasoningEfforts: ["max"],
        functionTools: true,
      }),
      connectionId,
      upstreamModelId,
    )
    .run()
  const key = await createAiKey([upstreamModelId])
  const reasoning = {
    type: "reasoning",
    content: [{ type: "reasoning_text", text: "synthetic tool reasoning" }],
  }
  const toolCall = {
    type: "function_call",
    name: "test_echo",
    call_id: "call_roundtrip",
    arguments: '{"text":"hello"}',
  }
  const upstreamBodies: Record<string, unknown>[] = []
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      const output =
        upstreamBodies.length === 1
          ? [reasoning, toolCall]
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello" }],
              },
            ]
      return sseUpstream([
        sseFrame("response.completed", {
          type: "response.completed",
          response: {
            status: "completed",
            reasoning: { effort: "max" },
            output,
            usage: { total_tokens: 12 },
          },
        }),
      ])
    })
  try {
    const prompt = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Call test_echo with text=hello" }],
    }
    const tools = [
      {
        type: "function",
        name: "test_echo",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ]
    const first = await call("/api/ai/responses", {
      headers: { "x-api-key": key },
      body: {
        model: upstreamModelId,
        input: [prompt],
        stream: false,
        tools,
        tool_choice: "auto",
      },
    })
    expect(first.status).toBe(200)
    const body = await first.json<{
      output: [typeof reasoning, typeof toolCall]
    }>()
    expect(body.output).toEqual([reasoning, toolCall])
    const [returnedReasoning, returnedCall] = body.output
    const args = JSON.parse(returnedCall.arguments) as { text: string }
    const input = [
      prompt,
      returnedReasoning,
      returnedCall,
      {
        type: "function_call_output",
        call_id: returnedCall.call_id,
        output: JSON.stringify({ echo: args.text }),
      },
    ]
    const second = await call("/api/ai/responses", {
      headers: { "x-api-key": key },
      body: {
        model: upstreamModelId,
        input,
        tools,
        tool_choice: "auto",
        stream: false,
      },
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      status: "completed",
      output: [{ type: "message", content: [{ text: "hello" }] }],
    })
    expect(upstreamBodies).toEqual([
      expect.objectContaining({
        input: [prompt],
        tools,
        tool_choice: "auto",
        reasoning: { effort: "max" },
      }),
      expect.objectContaining({
        input,
        tools,
        tool_choice: "auto",
        reasoning: { effort: "max" },
      }),
    ])
    expect(await reservedRowCount()).toBe(0)
    expect(
      (await env.DB.prepare("SELECT status FROM ai_invocations").all()).results,
    ).toEqual([{ status: "succeeded" }, { status: "succeeded" }])
  } finally {
    fetch.mockRestore()
  }
})

describe("DeepSeek thinking tool-choice compatibility", () => {
  const tools = [{ type: "function", name: "test_echo" }]
  const forcedChoices = [
    "required",
    { type: "function", name: "test_echo" },
  ] as const

  beforeEach(async () => {
    await env.DB.prepare(
      "UPDATE ai_models SET capabilities=? WHERE connectionId=? AND upstreamModelId=?",
    )
      .bind(
        JSON.stringify({
          supportedInApi: true,
          reasoningEfforts: ["none", "low", "high", "max"],
          functionTools: true,
        }),
        connectionId,
        upstreamModelId,
      )
      .run()
  })

  it.each(
    [undefined, "low", "high", "max"].flatMap((effort) =>
      [false, true].flatMap((stream) =>
        forcedChoices.map((choice) => ({ effort, stream, choice })),
      ),
    ),
  )(
    "rejects forced tools before upstream: %j",
    async ({ effort, stream, choice }) => {
      const key = await createAiKey([upstreamModelId])
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => sseUpstream(completedFrames))
      try {
        const response = await call("/api/ai/responses", {
          headers: { "x-api-key": key },
          body: {
            model: upstreamModelId,
            input: "Call test_echo",
            tools,
            tool_choice: choice,
            stream,
            ...(effort === undefined ? {} : { reasoning: { effort } }),
          },
        })
        expect(response.status).toBe(422)
        expect(await response.json()).toMatchObject({
          type: "https://auth.eruoo.me/problems/validation-failed",
        })
        expect(fetch).not.toHaveBeenCalled()
        expect(await reservedRowCount()).toBe(0)
      } finally {
        fetch.mockRestore()
      }
    },
  )

  it.each([
    ...[undefined, "none", "low", "high", "max"].flatMap((effort) =>
      [undefined, "auto", "none"].map((choice) => ({ effort, choice })),
    ),
    ...forcedChoices.map((choice) => ({ effort: "none", choice })),
  ])(
    "preserves supported tool choices and efforts: %j",
    async ({ effort, choice }) => {
      const key = await createAiKey([upstreamModelId])
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => sseUpstream(completedFrames))
      try {
        const response = await call("/api/ai/responses", {
          headers: { "x-api-key": key },
          body: {
            model: upstreamModelId,
            input: "Call test_echo",
            tools,
            stream: false,
            ...(choice === undefined ? {} : { tool_choice: choice }),
            ...(effort === undefined ? {} : { reasoning: { effort } }),
          },
        })
        expect(response.status).toBe(200)
        expect((await response.json<{ status: string }>()).status).toBe(
          "completed",
        )
        expect(fetch).toHaveBeenCalledTimes(1)
        const forwarded = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
        expect(forwarded.reasoning).toEqual({ effort: effort ?? "max" })
        expect(forwarded.tool_choice).toEqual(choice)
        expect(await reservedRowCount()).toBe(0)
      } finally {
        fetch.mockRestore()
      }
    },
  )
})

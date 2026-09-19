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
import { ownerSession } from "./fixtures/session"

const connectionId = "11111111-1111-1111-1111-111111111111"
const upstreamModelId = "gpt-test"
const externalModelId = "codex-main/gpt-test"
const reasoningUpstreamModelId = "gpt-reasoning"
const reasoningExternalModelId = `codex-main/${reasoningUpstreamModelId}`

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
      accessToken: "access-token-1",
      chatgptUserId: "user-main",
      refreshToken: "refresh-token-1",
    }),
    {
      connectionId,
      environment: env.APP_ORIGIN,
      providerType: "openai-codex",
      purpose: "credential-package",
    },
  )
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO "ai_connections" ("id","slug","name","providerType","enabled","authorizationStatus","upstreamAccountId","credentialVersion","credentialCiphertext","credentialExpiresAt","refreshClaimId","refreshClaimExpiresAt","createdAt","updatedAt")
       VALUES (?,?,?,?,1,'connected','account-main',1,?,?,NULL,NULL,?,?)`,
    ).bind(
      connectionId,
      "codex-main",
      "Main",
      "openai-codex",
      ciphertext,
      now + 3_600_000,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES (?,?,NULL,NULL,1,?)`,
    ).bind(connectionId, upstreamModelId, now),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES (?,?,NULL,NULL,1,?)`,
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
        reasoningEfforts: ["low", "high"],
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
    body: { modelIds, name: "ai route probe", purpose: "ai" },
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
  it("lists only the models the key was granted", async () => {
    const key = await createAiKey([externalModelId])
    const response = await call("/api/ai/models", {
      headers: { "x-api-key": key },
    })
    expect(response.status).toBe(200)
    const body = await response.json<{ models: { id: string }[] }>()
    expect(body.models.map((model) => model.id)).toEqual([externalModelId])
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
    const key = await createAiKey(["codex-main/other-model"])
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
      body: { input: "hi", model: "codex-main/not-in-catalog" },
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
    const ungrantedKey = await createAiKey(
      ["codex-main/other-model"],
      session.cookie,
    )
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
        body: { input: "hi", model: "codex-main/not-in-catalog" },
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

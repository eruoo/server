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
  } = {},
) {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body)
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
  ])
}

/** Creates an ai-profile key through the real gateway. */
async function createAiKey(modelIds: string[]): Promise<string> {
  const session = await ownerSession()
  const response = await call("/api/auth/api-key/create", {
    body: { modelIds, name: "ai route probe", purpose: "ai" },
    cookie: session.cookie,
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

    // The invocation row is committed with the terminal outcome.
    const rows = await env.DB.prepare(
      "SELECT status, errorCode FROM ai_invocations",
    ).all<{ errorCode: string | null; status: string }>()
    expect(rows.results).toEqual([{ errorCode: null, status: "succeeded" }])
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

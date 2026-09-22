import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAiConnection } from "../../src/worker/ai/connections"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import {
  readAiInvocation,
  assignAiInvocationIdentity,
  reserveAiInvocation,
} from "../../src/worker/ai/invocations"
import type { ResponsesRequestBody } from "../../src/worker/ai/responses-request"
import { invokeDeepSeekResponses } from "../../src/worker/ai/responses-transport"

const environment = "http://local.test"
const connectionId = "11111111-1111-1111-1111-111111111111"
const requestId = "33333333-3333-3333-3333-333333333333"
const apiKeyId = "key-transport"
const ownerUserId = "transport-owner"
const ownerSessionId = "transport-owner-session"
const upstreamModelId = "deepseek-flash"

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const keyV1 = crypto.getRandomValues(new Uint8Array(32))
const keyringRaw = `1:${toBase64Url(keyV1)}`

async function encryptPackage(): Promise<string> {
  const keyring = await parseAiCredentialKeyring(keyringRaw)
  return encryptAiSecret(
    keyring,
    JSON.stringify({
      kind: "api-key",
      apiKey: "synthetic-upstream-key",
    }),
    {
      connectionId,
      environment,
      providerType: "deepseek",
      purpose: "credential-package",
    },
  )
}

/** Reaches the connected state through the real storage primitives. */
async function createConnectedConnection(): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    ).bind(
      ownerUserId,
      "Owner",
      `${ownerUserId}@example.invalid`,
      1,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId,reauthenticatedAt) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      ownerSessionId,
      new Date(now + 30 * 86_400_000).toISOString(),
      `token-${ownerSessionId}`,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      ownerUserId,
      new Date(now).toISOString(),
    ),
  ])
  const created = await createAiConnection(env.DB, {
    id: connectionId,
    name: "Main",
    now,
    providerType: "deepseek",
  })
  expect(created).toMatchObject({ created: true })
  await env.DB.prepare(
    "UPDATE ai_connections SET authorizationStatus='connected', credentialCiphertext=?, credentialVersion=1 WHERE id=?",
  )
    .bind(await encryptPackage(), connectionId)
    .run()
}

async function reserve(input: {
  deadlineAt: number
  startedAt: number
}): Promise<void> {
  const reserved = await reserveAiInvocation(env.DB, {
    apiKeyId,
    deadlineAt: input.deadlineAt,
    requestId,
    startedAt: input.startedAt,
  })
  expect(reserved).toMatchObject({ reserved: true })
  // The transport is invoked directly here, so the identity the route records
  // after resolving the model is recorded by the fixture.
  expect(
    await assignAiInvocationIdentity(env.DB, {
      connectionId,
      requestId,
      upstreamModelId,
    }),
  ).toEqual({ assigned: true })
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sseUpstream(
  frames: string[],
  init: { headers?: Record<string, string>; status?: number } = {},
): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        ...init.headers,
      },
      status: init.status ?? 200,
    },
  )
}

/** A 200 response whose body never sends a chunk. */
function stallingUpstream(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  })
}

interface UpstreamCall {
  body: Record<string, unknown> | null
  headers: Record<string, string>
  url: string
}

interface TransportMock {
  calls: UpstreamCall[]
}

const mocks: Array<{ restore: () => void }> = []

/**
 * Only the fixed DeepSeek Responses endpoint is allowed.
 */
function installUpstreamMock(handlers: {
  responses?: (init?: RequestInit) => Response | Promise<Response>
}): TransportMock {
  const mock: TransportMock = { calls: [] }
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(init?.redirect).toBe("manual")
      const request = new Request(input, init)
      const url = new URL(request.url)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      const call: UpstreamCall = {
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null,
        headers,
        url: request.url,
      }
      if (
        url.origin === "https://api.deepseek.com" &&
        url.pathname === "/responses"
      ) {
        mock.calls.push(call)
        if (handlers.responses === undefined) {
          throw new Error("Unexpected responses call")
        }
        return handlers.responses(init)
      }
      throw new Error(
        `Unexpected outbound request: ${request.method} ${request.url}`,
      )
    })
  mocks.push({ restore: () => spy.mockRestore() })
  return mock
}

afterEach(() => {
  while (mocks.length > 0) mocks.pop()?.restore()
  vi.restoreAllMocks()
})

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_invocations"),
    env.DB.prepare("DELETE FROM ai_models"),
    env.DB.prepare("DELETE FROM ai_connections"),
    env.DB.prepare("DELETE FROM user"),
  ])
})

function requestBody(
  overrides: Partial<ResponsesRequestBody> = {},
): ResponsesRequestBody {
  return {
    input: "hello",
    model: "deepseek-flash",
    stream: true,
    ...overrides,
  }
}

function invoke(input: {
  budgets?: {
    credentialStageMs?: number
    firstResponseMs?: number
    noDataIntervalMs?: number
  }
  request?: ResponsesRequestBody
  signal?: AbortSignal
}) {
  const startedAt = Date.now()
  return invokeDeepSeekResponses({
    apiKeyId,
    observedCredentialVersion: 1,
    observedPermissionVersion: 0,
    budgets: input.budgets,
    connectionId,
    credentialKeys: keyringRaw,
    database: env.DB,
    deadlineAt: startedAt + 60_000,
    environment,
    request: input.request ?? requestBody(),
    requestId,
    signal: input.signal,
    startedAt,
    upstreamModelId,
  })
}

const completedFrames = [
  sseFrame("response.created", {
    response: { id: "resp_1" },
    type: "response.created",
  }),
  sseFrame("response.output_text.delta", {
    delta: "hi",
    type: "response.output_text.delta",
  }),
  sseFrame("response.output_item.done", {
    item: { content: [], id: "item_1", role: "assistant", type: "message" },
    output_index: 0,
    type: "response.output_item.done",
  }),
  sseFrame("response.completed", {
    response: {
      id: "resp_1",
      output: [
        { content: [], id: "item_1", role: "assistant", type: "message" },
      ],
      status: "completed",
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    },
    type: "response.completed",
  }),
]

describe("responses transport", () => {
  it("streams the upstream events and commits the completed outcome", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    const mock = installUpstreamMock({
      responses: () =>
        sseUpstream(completedFrames, {
          headers: { "x-request-id": "upstream-1" },
        }),
    })

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(200)
    expect(delivery.response.headers.get("content-type")).toBe(
      "text/event-stream",
    )
    const text = await delivery.response.text()
    expect(text).toContain("event: response.created")
    expect(text).toContain('"delta":"hi"')
    expect(text).toContain("event: response.completed")
    await delivery.settled

    // The upstream call carries the fixed address, identity headers, and the
    // normalized body.
    expect(mock.calls.length).toBe(1)
    const call = mock.calls[0]
    expect(call.url).toBe("https://api.deepseek.com/responses")
    expect(call.headers.accept).toBe("text/event-stream")
    expect(call.headers["content-type"]).toBe("application/json")
    expect(call.headers.originator).toBeUndefined()
    expect(call.headers["user-agent"]).toBeUndefined()
    expect(call.headers["chatgpt-account-id"]).toBeUndefined()
    expect(call.headers.authorization).toMatch(/^Bearer /)
    expect(call.body).toMatchObject({
      instructions: "",
      model: upstreamModelId,
      reasoning: { effort: "max" },
      stream: true,
    })

    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: null,
      status: "succeeded",
      upstreamRequestId: "upstream-1",
    })
    expect(row?.usage).toContain('"total_tokens":10')
  })

  it("returns the terminal response object in JSON mode", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => sseUpstream(completedFrames) })

    const delivery = await invoke({ request: requestBody({ stream: false }) })
    expect(delivery.response.status).toBe(200)
    expect(delivery.response.headers.get("content-type")).toContain(
      "application/json",
    )
    const body = (await delivery.response.json()) as {
      output: unknown[]
      status: string
      usage: { total_tokens: number }
    }
    expect(body.status).toBe("completed")
    expect(body.output.length).toBe(1)
    expect(body.usage.total_tokens).toBe(10)
    await delivery.settled

    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ status: "succeeded" })
    expect(row?.usage).toContain('"total_tokens":10')
  })

  it("records an incomplete terminal as incomplete", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () =>
        sseUpstream([
          sseFrame("response.incomplete", {
            response: {
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
              status: "incomplete",
            },
            type: "response.incomplete",
          }),
        ]),
    })

    const delivery = await invoke({ request: requestBody({ stream: false }) })
    expect(delivery.response.status).toBe(200)
    const body = (await delivery.response.json()) as { status: string }
    expect(body.status).toBe("incomplete")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ errorCode: null, status: "incomplete" })
  })

  it("classifies upstream 429 as rate limited", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          headers: {
            "content-type": "application/json",
            "x-request-id": "upstream-429",
          },
          status: 429,
        }),
    })

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(429)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-rate-limited")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-rate-limited",
      status: "failed",
      upstreamRequestId: "upstream-429",
    })
  })

  it("maps other upstream HTTP failures to a protocol error", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () => jsonResponse({ error: { message: "bad request" } }, 400),
    })

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(502)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-protocol-error")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-protocol-error",
      status: "failed",
    })
  })

  it("fails as request-timeout when the upstream never answers", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        }),
    })

    const delivery = await invoke({ budgets: { firstResponseMs: 50 } })
    expect(delivery.response.status).toBe(504)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("request-timeout")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "request-timeout",
      status: "failed",
    })
  })

  it("delivers an unavailable terminal when the upstream stalls without data", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => stallingUpstream() })

    const delivery = await invoke({ budgets: { noDataIntervalMs: 50 } })
    expect(delivery.response.status).toBe(200)
    const text = await delivery.response.text()
    expect(text).toContain("event: error")
    expect(text).toContain("ai-upstream-unavailable")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-unavailable",
      status: "failed",
    })
  })

  it("fails as unavailable when the total deadline expires mid-stream", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => stallingUpstream() })

    const delivery = await invokeDeepSeekResponses({
      apiKeyId,
      observedCredentialVersion: 1,
      observedPermissionVersion: 0,
      // The silence budget outlives the deadline, so the deadline is what
      // cuts the stalled read.
      budgets: { noDataIntervalMs: 30_000 },
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: Date.now() + 60,
      environment,
      request: requestBody({ stream: false }),
      requestId,
      startedAt,
      upstreamModelId,
    })
    expect(delivery.response.status).toBe(503)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-unavailable")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-unavailable",
      status: "failed",
    })
  })

  it.each([true, false])(
    "keeps one midstream-deadline classification across the SSE frame, JSON mode and the record (stream=%s)",
    async (stream) => {
      await createConnectedConnection()
      const startedAt = Date.now()
      await reserve({ deadlineAt: startedAt + 60_000, startedAt })
      installUpstreamMock({ responses: () => stallingUpstream() })

      // The silence budget outlives the deadline, so the total deadline is
      // what ends the stalled upstream read — after the response was already
      // established, which per the contract classifies as upstream
      // unavailability, never a handshake timeout.
      const delivery = await invokeDeepSeekResponses({
        apiKeyId,
        observedCredentialVersion: 1,
        observedPermissionVersion: 0,
        budgets: { noDataIntervalMs: 30_000 },
        connectionId,
        credentialKeys: keyringRaw,
        database: env.DB,
        deadlineAt: Date.now() + 100,
        environment,
        request: requestBody({ stream }),
        requestId,
        startedAt,
        upstreamModelId,
      })
      let delivered: { status: number; type: string }
      let sseErrorFrameCount = 0
      if (stream) {
        const text = await delivery.response.text()
        sseErrorFrameCount = text.split("event: error\n").length - 1
        const dataLine = text
          .split("\n")
          .find((line) => line.startsWith("data: "))
        if (dataLine === undefined) throw new Error("no error frame delivered")
        delivered = JSON.parse(dataLine.slice("data: ".length)) as {
          status: number
          type: string
        }
      } else {
        delivered = (await delivery.response.json()) as {
          status: number
          type: string
        }
      }
      await delivery.settled
      const row = await readAiInvocation(env.DB, requestId, Date.now())
      expect(row).toMatchObject({
        errorCode: "ai-upstream-unavailable",
        status: "failed",
      })
      // The SSE envelope keeps its 200 with exactly one error terminal; JSON
      // mode answers with the Problem status itself.
      expect(delivery.response.status).toBe(stream ? 200 : 503)
      expect(sseErrorFrameCount).toBe(stream ? 1 : 0)
      expect(delivered).toMatchObject({
        status: 503,
        type: `https://auth.eruoo.me/problems/${row!.errorCode}`,
      })
    },
  )

  it("settles and records a timeout when a stalled consumer meets the deadline", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    const bigDelta = sseFrame("response.output_text.delta", {
      delta: "a".repeat(100_000),
      type: "response.output_text.delta",
    })
    installUpstreamMock({
      responses: () =>
        sseUpstream([
          ...Array.from({ length: 4 }, () => bigDelta),
          ...completedFrames.slice(-1),
        ]),
    })

    const delivery = await invokeDeepSeekResponses({
      apiKeyId,
      observedCredentialVersion: 1,
      observedPermissionVersion: 0,
      budgets: { noDataIntervalMs: 30_000 },
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: Date.now() + 80,
      environment,
      request: requestBody(),
      requestId,
      startedAt,
      upstreamModelId,
    })
    expect(delivery.response.status).toBe(200)

    // Nobody reads the body: the deadline must still settle the invocation
    // instead of waiting for a consumer that never resumes.
    const settled = await Promise.race([
      delivery.settled.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 1_000),
      ),
    ])
    expect(settled).toBe("settled")
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-unavailable",
      status: "failed",
      usage: null,
    })
  })

  it("records an oversized usage as unknown rather than failing the commit", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () =>
        sseUpstream([
          sseFrame("response.completed", {
            response: {
              output: [],
              status: "completed",
              usage: { padding: "u".repeat(5_000) },
            },
            type: "response.completed",
          }),
        ]),
    })

    const delivery = await invoke({ request: requestBody({ stream: false }) })
    expect(delivery.response.status).toBe(200)
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ status: "succeeded", usage: null })
  })

  it("fails as a protocol error when the upstream body is missing", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () => new Response(null, { status: 200 }),
    })

    const delivery = await invoke({ request: requestBody({ stream: false }) })
    expect(delivery.response.status).toBe(502)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-protocol-error")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-protocol-error",
      status: "failed",
    })
  })

  it("fails as a protocol error when the upstream ends without a terminal", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: () =>
        sseUpstream([
          sseFrame("response.created", {
            response: { id: "resp_1" },
            type: "response.created",
          }),
        ]),
    })

    const delivery = await invoke({ request: requestBody({ stream: false }) })
    expect(delivery.response.status).toBe(502)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-protocol-error")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-protocol-error",
      status: "failed",
    })
  })

  it("records an unknown outcome when the client aborts", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => sseUpstream(completedFrames) })
    const controller = new AbortController()
    controller.abort()

    const delivery = await invoke({ signal: controller.signal })
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ errorCode: null, status: "unknown" })
  })

  it("fails as request-timeout when the deadline expires before any response", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({
      responses: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        }),
    })

    const delivery = await invokeDeepSeekResponses({
      apiKeyId,
      observedCredentialVersion: 1,
      observedPermissionVersion: 0,
      // The first-response budget outlives the deadline, so the deadline is
      // what cuts the handshake.
      budgets: { firstResponseMs: 30_000 },
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: Date.now() + 60,
      environment,
      request: requestBody(),
      requestId,
      startedAt,
      upstreamModelId,
    })
    expect(delivery.response.status).toBe(504)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("request-timeout")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "request-timeout",
      status: "failed",
    })
  })

  it("starts no upstream call when the deadline has already passed", async () => {
    await createConnectedConnection()
    const startedAt = Date.now() - 10_000
    await reserve({ deadlineAt: startedAt + 5_000, startedAt })
    const mock = installUpstreamMock({})

    const delivery = await invokeDeepSeekResponses({
      apiKeyId,
      observedCredentialVersion: 1,
      observedPermissionVersion: 0,
      budgets: { firstResponseMs: 30_000 },
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: startedAt + 5_000,
      environment,
      request: requestBody(),
      requestId,
      startedAt,
      upstreamModelId,
    })

    expect(delivery.response.status).toBe(504)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("request-timeout")
    expect(mock.calls.length).toBe(0)
    await delivery.settled
    expect(await readAiInvocation(env.DB, requestId, Date.now())).toMatchObject(
      {
        errorCode: "request-timeout",
        status: "failed",
      },
    )
  })

  it("clamps an over-long deadline to the shared 300-second policy", async () => {
    const now = Date.now()
    await createConnectedConnection()
    // The caller asks for 400 seconds; the shared policy allows 300, which
    // this start time places in the past, so the deadline fires at once.
    const startedAt = now - 400_000
    await reserve({ deadlineAt: startedAt + 400_000, startedAt })
    installUpstreamMock({
      responses: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        }),
    })

    const delivery = await invokeDeepSeekResponses({
      apiKeyId,
      observedCredentialVersion: 1,
      observedPermissionVersion: 0,
      budgets: { firstResponseMs: 30_000 },
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: startedAt + 400_000,
      environment,
      request: requestBody(),
      requestId,
      startedAt,
      upstreamModelId,
    })
    expect(delivery.response.status).toBe(504)
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "request-timeout",
      status: "failed",
    })
  })

  it("rejects settled when the outcome commit cannot land", async () => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => sseUpstream(completedFrames) })
    // The reserved row disappears before the terminal write; the streaming
    // outcome can no longer be committed and must not report success.
    await env.DB.prepare('DELETE FROM "ai_invocations" WHERE "requestId" = ?1')
      .bind(requestId)
      .run()

    const delivery = await invoke({})
    await expect(delivery.settled).rejects.toThrow(
      "The AI invocation outcome was not committed",
    )
  })
})

it.each([
  [401, 503, "ai-reauthorization-required"],
  [402, 429, "ai-upstream-quota-exceeded"],
  [403, 503, "ai-upstream-unavailable"],
  [503, 503, "ai-upstream-unavailable"],
  [302, 502, "ai-upstream-protocol-error"],
] as const)(
  "maps HTTP %i without retry or error leakage",
  async (upstreamStatus, status, code) => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ startedAt, deadlineAt: startedAt + 60000 })
    const mock = installUpstreamMock({
      responses: () =>
        jsonResponse(
          { error: "synthetic-private-upstream-error" },
          upstreamStatus,
        ),
    })
    const delivery = await invoke({})
    expect(delivery.response.status).toBe(status)
    const text = await delivery.response.text()
    expect(text).toContain(code)
    expect(text).not.toContain("synthetic-private-upstream-error")
    expect(mock.calls).toHaveLength(1)
    await delivery.settled
    const connection = await env.DB.prepare(
      "SELECT authorizationStatus,credentialVersion FROM ai_connections WHERE id=?",
    )
      .bind(connectionId)
      .first()
    expect(connection).toEqual({
      authorizationStatus:
        upstreamStatus === 401 ? "reauthentication_required" : "connected",
      credentialVersion: upstreamStatus === 401 ? 2 : 1,
    })
  },
)

it.each([true, false])(
  "preserves reasoning and tool events with effort none (stream=%s)",
  async (stream) => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ startedAt, deadlineAt: startedAt + 60000 })
    const reasoning = {
      type: "reasoning",
      id: "reason_1",
      content: [{ type: "reasoning_text", text: "synthetic thought" }],
    }
    const call = {
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      arguments: "{}",
    }
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3 },
    }
    const mock = installUpstreamMock({
      responses: () =>
        sseUpstream([
          sseFrame("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            delta: "synthetic thought",
          }),
          sseFrame("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item: reasoning,
          }),
          sseFrame("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            delta: "{}",
          }),
          sseFrame("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 1,
            item: call,
          }),
          sseFrame("response.completed", {
            type: "response.completed",
            response: { output: [reasoning, call], usage },
          }),
        ]),
    })
    const delivery = await invoke({
      request: requestBody({ stream, reasoning: { effort: "none" } }),
    })
    const text = await delivery.response.text()
    expect(text).toContain("synthetic thought")
    expect(text).toContain('"function_call"')
    expect(text).not.toContain("[DONE]")
    expect(text.includes("response.function_call_arguments.delta")).toBe(stream)
    expect(mock.calls[0].body?.reasoning).toEqual({ effort: "none" })
    await delivery.settled
    expect((await readAiInvocation(env.DB, requestId, Date.now()))?.usage).toBe(
      JSON.stringify(usage),
    )
  },
)

it.each([true, false])(
  "records actual usage even for a failed terminal (stream=%s)",
  async (stream) => {
    await createConnectedConnection()
    const startedAt = Date.now()
    await reserve({ startedAt, deadlineAt: startedAt + 60000 })
    installUpstreamMock({
      responses: () =>
        sseUpstream([
          sseFrame("response.failed", {
            type: "response.failed",
            response: {
              error: "synthetic-private-error",
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          }),
        ]),
    })
    const delivery = await invoke({ request: requestBody({ stream }) })
    expect(await delivery.response.text()).not.toContain(
      "synthetic-private-error",
    )
    await delivery.settled
    expect(await readAiInvocation(env.DB, requestId, Date.now())).toMatchObject(
      { status: "failed", usage: '{"input_tokens":10,"output_tokens":2}' },
    )
  },
)

it("forwards structured output and complete reasoning/tool history with default max", async () => {
  await createConnectedConnection()
  const startedAt = Date.now()
  await reserve({ startedAt, deadlineAt: startedAt + 60000 })
  const request = requestBody({
    stream: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Call echo" }],
      },
      {
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "synthetic thought" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "echo",
        arguments: '{"text":"hello"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"echo":"hello"}',
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "echo_result",
        schema: {
          type: "object",
          properties: { echo: { type: "string" } },
          required: ["echo"],
          additionalProperties: false,
        },
      },
    },
  })
  const mock = installUpstreamMock({
    responses: () => sseUpstream(completedFrames),
  })
  const delivery = await invoke({ request })
  expect(delivery.response.status).toBe(200)
  await delivery.response.text()
  await delivery.settled
  expect(mock.calls[0].body).toMatchObject({
    input: request.input,
    text: request.text,
    reasoning: { effort: "max" },
  })
})

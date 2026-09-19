import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  claimAiAuthorizationPoll,
  completeAiAuthorization,
  createAiAuthorizationSession,
} from "../../src/worker/ai/authorizations"
import {
  createAiConnection,
  getAiConnection,
} from "../../src/worker/ai/connections"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import { acquireAiCredentialRefreshClaim } from "../../src/worker/ai/credentials"
import {
  readAiInvocation,
  reserveAiInvocation,
} from "../../src/worker/ai/invocations"
import type { ResponsesRequestBody } from "../../src/worker/ai/responses-request"
import { invokeCodexResponses } from "../../src/worker/ai/responses-transport"

const environment = "http://local.test"
const connectionId = "11111111-1111-1111-1111-111111111111"
const requestId = "33333333-3333-3333-3333-333333333333"
const apiKeyId = "key-transport"
const ownerUserId = "transport-owner"
const ownerSessionId = "transport-owner-session"
const upstreamModelId = "gpt-test"

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const keyV1 = crypto.getRandomValues(new Uint8Array(32))
const keyringRaw = `1:${toBase64Url(keyV1)}`

function fakeAccessToken(expiryMs: number, label = "access"): string {
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  )
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp: Math.floor(expiryMs / 1_000),
        sub: `access-${label}`,
      }),
    ),
  )
  return `${header}.${payload}.${toBase64Url(new Uint8Array(32))}`
}

async function encryptPackage(input: {
  accessToken: string
  refreshToken?: string
}): Promise<string> {
  const keyring = await parseAiCredentialKeyring(keyringRaw)
  return encryptAiSecret(
    keyring,
    JSON.stringify({
      accessToken: input.accessToken,
      chatgptUserId: "user-main",
      refreshToken: input.refreshToken ?? "refresh-token-1",
    }),
    {
      connectionId,
      environment,
      providerType: "openai-codex",
      purpose: "credential-package",
    },
  )
}

/** Reaches the connected state through the real storage primitives. */
async function createConnectedConnection(input: {
  accessToken: string
  expiresAtMs: number
  refreshToken?: string
}): Promise<void> {
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
    providerType: "openai-codex",
    slug: "codex-main",
  })
  expect(created).toMatchObject({ created: true })
  const authorizationSessionId = "22222222-2222-2222-2222-222222222222"
  const claimId = "55555555-5555-5555-5555-555555555555"
  const session = await createAiAuthorizationSession(env.DB, {
    connectionId,
    deviceGrantCiphertext: "device-grant-transport",
    id: authorizationSessionId,
    ownerSessionId,
    ownerUserId,
    pollIntervalMs: 5_000,
    sessionTtlMs: 900_000,
    now,
  })
  expect(session).toMatchObject({ created: true })
  const claimed = await claimAiAuthorizationPoll(env.DB, {
    claimId,
    now: now + 6_000,
    ownerSessionId,
    ownerUserId,
    sessionId: authorizationSessionId,
  })
  expect(claimed).toMatchObject({ claimed: true })
  const completed = await completeAiAuthorization(env.DB, {
    claimId,
    completionId: "66666666-6666-6666-6666-666666666666",
    credentialCiphertext: await encryptPackage({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
    }),
    credentialExpiresAt: input.expiresAtMs,
    now: now + 7_000,
    sessionId: authorizationSessionId,
    upstreamAccountId: "account-main",
  })
  expect(completed).toMatchObject({ completed: true })
}

async function reserve(input: {
  deadlineAt: number
  startedAt: number
}): Promise<void> {
  const reserved = await reserveAiInvocation(env.DB, {
    apiKeyId,
    connectionId,
    deadlineAt: input.deadlineAt,
    requestId,
    startedAt: input.startedAt,
    upstreamModelId,
  })
  expect(reserved).toMatchObject({ reserved: true })
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
  refreshCalls: UpstreamCall[]
}

const mocks: Array<{ restore: () => void }> = []

/**
 * Routes outbound calls: the fixed Codex responses endpoint, and the fixed
 * token endpoint for refresh paths. Any other URL fails the test.
 */
function installUpstreamMock(handlers: {
  refresh?: (init?: RequestInit) => Response | Promise<Response>
  responses?: (init?: RequestInit) => Response | Promise<Response>
}): TransportMock {
  const mock: TransportMock = { calls: [], refreshCalls: [] }
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
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
        url.origin === "https://chatgpt.com" &&
        url.pathname === "/backend-api/codex/responses"
      ) {
        mock.calls.push(call)
        if (handlers.responses === undefined) {
          throw new Error("Unexpected responses call")
        }
        return handlers.responses(init)
      }
      if (
        url.origin === "https://auth.openai.com" &&
        url.pathname === "/oauth/token"
      ) {
        mock.refreshCalls.push(call)
        if (handlers.refresh === undefined) {
          throw new Error("Unexpected refresh call")
        }
        return handlers.refresh(init)
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
    model: "codex-main/gpt-test",
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
  return invokeCodexResponses({
    apiKeyId,
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(call.headers.accept).toBe("text/event-stream")
    expect(call.headers["content-type"]).toBe("application/json")
    expect(call.headers.originator).toBe("eruoo")
    expect(call.headers["user-agent"]).toBe("eruoo/1")
    expect(call.headers["chatgpt-account-id"]).toBe("account-main")
    expect(call.headers.authorization).toMatch(/^Bearer /)
    expect(call.body).toMatchObject({
      instructions: "",
      model: upstreamModelId,
      store: false,
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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

  it("recovers a pre-stream 401 with one forced refresh and one replay", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    const rotated = fakeAccessToken(Date.now() + 3_600_000, "rotated")
    const mock = installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: rotated,
          refresh_token: "refresh-token-2",
        }),
      responses: (init) => {
        const request = new Request("https://x.test", init)
        // Only the refreshed token is accepted; the first call 401s.
        return request.headers.get("authorization") === `Bearer ${rotated}`
          ? sseUpstream(completedFrames)
          : jsonResponse({ error: { message: "unauthorized" } }, 401)
      },
    })

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(200)
    await delivery.settled

    expect(mock.calls.length).toBe(2)
    expect(mock.refreshCalls.length).toBe(1)
    expect(mock.calls[0].headers.authorization).not.toBe(`Bearer ${rotated}`)
    expect(mock.calls[1].headers.authorization).toBe(`Bearer ${rotated}`)
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection?.credentialVersion).toBe(2)
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ status: "succeeded" })
  })

  it("marks the connection when a 401 survives the replay", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    const mock = installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(Date.now() + 3_600_000, "rotated"),
          refresh_token: "refresh-token-2",
        }),
      responses: () =>
        jsonResponse({ error: { message: "unauthorized" } }, 401),
    })

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(503)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-reauthorization-required")
    await delivery.settled

    expect(mock.calls.length).toBe(2)
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
    })
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-reauthorization-required",
      status: "failed",
    })
  })

  it("classifies a bare upstream 429 as unavailable", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    expect(delivery.response.status).toBe(503)
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-upstream-unavailable")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-upstream-unavailable",
      status: "failed",
      upstreamRequestId: "upstream-429",
    })
  })

  it("maps other upstream HTTP failures to a protocol error", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    installUpstreamMock({ responses: () => stallingUpstream() })

    const delivery = await invokeCodexResponses({
      apiKeyId,
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

  it("records an oversized usage as unknown rather than failing the commit", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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

  it("refreshes a needed credential even when the stage is entered late", async () => {
    const now = Date.now()
    await createConnectedConnection({
      // Inside the 60-second refresh lead, so the call must refresh.
      accessToken: fakeAccessToken(now + 30_000),
      expiresAtMs: now + 30_000,
    })
    // The invocation started 20 seconds ago: admission already consumed
    // time, and the credential stage window must not be measured from then.
    const startedAt = now - 20_000
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    const mock = installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "fresh"),
          refresh_token: "refresh-token-2",
        }),
      responses: () => sseUpstream(completedFrames),
    })

    const delivery = await invokeCodexResponses({
      apiKeyId,
      connectionId,
      credentialKeys: keyringRaw,
      database: env.DB,
      deadlineAt: startedAt + 60_000,
      environment,
      request: requestBody(),
      requestId,
      startedAt,
      upstreamModelId,
    })
    expect(delivery.response.status).toBe(200)
    await delivery.settled
    expect(mock.refreshCalls.length).toBe(1)
    expect(mock.calls.length).toBe(1)
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({ status: "succeeded" })
  })

  it("fails as request-timeout when the deadline expires before any response", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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

    const delivery = await invokeCodexResponses({
      apiKeyId,
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

  it("clamps an over-long deadline to the shared 300-second policy", async () => {
    const now = Date.now()
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
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

    const delivery = await invokeCodexResponses({
      apiKeyId,
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
    await createConnectedConnection({
      accessToken: fakeAccessToken(Date.now() + 3_600_000),
      expiresAtMs: Date.now() + 3_600_000,
    })
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

  it("fails as credential-busy while another request holds the refresh claim", async () => {
    const now = Date.now()
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 1_000),
      expiresAtMs: now + 1_000,
    })
    const startedAt = Date.now()
    await reserve({ deadlineAt: startedAt + 60_000, startedAt })
    // The claim stamps updatedAt, and the schema keeps updatedAt >= createdAt;
    // the fixture writes its own clock, so read the claim clock after it.
    const claimed = await acquireAiCredentialRefreshClaim(env.DB, {
      claimId: "77777777-7777-7777-7777-777777777777",
      connectionId,
      now: Math.max(now, Date.now()),
    })
    expect(claimed).toMatchObject({ claimed: true })
    installUpstreamMock({})

    const delivery = await invoke({})
    expect(delivery.response.status).toBe(503)
    expect(delivery.response.headers.get("retry-after")).toBe("30")
    const problem = (await delivery.response.json()) as { type: string }
    expect(problem.type).toContain("ai-credential-busy")
    await delivery.settled
    const row = await readAiInvocation(env.DB, requestId, Date.now())
    expect(row).toMatchObject({
      errorCode: "ai-credential-busy",
      status: "failed",
    })
  })
})

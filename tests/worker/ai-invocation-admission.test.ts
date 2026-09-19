import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import { ownerSession } from "./fixtures/session"

/**
 * The admission deadline is read from the wall clock, so a reservation whose
 * write lands after the budget is only reachable with a clock that moves past
 * it. The offset is flipped by the reservation write itself: the request is
 * admitted inside the budget, then reads a clock that is already past it.
 */
const clock = { offsetMs: 0 }

/**
 * Wraps one statement so that `run()` flips the clock once the write it
 * represents has landed. Only the admission insert is wrapped, so no other
 * statement in the request sees the moved clock.
 */
function makeReservationWriteLate(
  sql: string,
  statement: D1PreparedStatement,
): D1PreparedStatement {
  if (!sql.includes(`INSERT INTO "ai_invocations"`)) return statement
  return new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...args: unknown[]) => {
          const bound = (
            target.bind as (...values: unknown[]) => D1PreparedStatement
          )(...args)
          return new Proxy(bound, {
            get(boundTarget, boundProperty) {
              if (boundProperty === "run") {
                return async () => {
                  const result = await (
                    boundTarget.run as () => Promise<unknown>
                  ).call(boundTarget)
                  clock.offsetMs = 6_000
                  return result
                }
              }
              const value = Reflect.get(boundTarget, boundProperty)
              return typeof value === "function"
                ? value.bind(boundTarget)
                : value
            },
          })
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as D1PreparedStatement
}

const connectionId = "11111111-1111-1111-1111-111111111111"
const upstreamModelId = "gpt-test"
const externalModelId = "codex-main/gpt-test"

let sequence = 0
async function call(
  path: string,
  options: { body?: unknown; headers?: Record<string, string> },
) {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "cf-connecting-ip": `ai-admission-${++sequence}`,
        "content-type": "application/json",
        origin: env.APP_ORIGIN,
        ...options.headers,
      },
      body: JSON.stringify(options.body),
    }),
    env,
    context,
  )
  await waitOnExecutionContext(context)
  return response
}

beforeEach(async () => {
  clock.offsetMs = 0
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
  const now = Date.now()
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
  ])
})

describe("AI invocation admission", () => {
  it("releases the slot as soon as the client disconnects during the body read", async () => {
    const session = await ownerSession()
    const created = await call("/api/auth/api-key/create", {
      body: {
        modelIds: [externalModelId],
        name: "admission probe",
        purpose: "ai",
      },
      headers: { cookie: session.cookie },
    })
    expect(created.status).toBe(200)
    const { key } = await created.json<{ key: string }>()

    const controller = new AbortController()
    const encoder = new TextEncoder()
    const stalledBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        // A partial body that never completes: the client goes away while the
        // route is still waiting for the rest of it.
        streamController.enqueue(
          encoder.encode(
            `{"input":"hi","model":"${externalModelId.slice(0, 8)}`,
          ),
        )
      },
    })
    const fetchMock = vi.spyOn(globalThis, "fetch")
    const context = createExecutionContext()
    const startedAt = Date.now()
    let response: Response
    try {
      const pending = worker.fetch(
        new Request(`${env.APP_ORIGIN}/api/ai/responses`, {
          body: stalledBody,
          headers: {
            "cf-connecting-ip": `ai-admission-${++sequence}`,
            "content-type": "application/json",
            origin: env.APP_ORIGIN,
            "x-api-key": key,
          },
          method: "POST",
          signal: controller.signal,
        }),
        env,
        context,
      )
      setTimeout(() => controller.abort(), 50)
      response = await pending
      await waitOnExecutionContext(context)
    } finally {
      fetchMock.mockRestore()
    }

    // The disconnect ends the wait immediately instead of at the 15 second
    // body-read budget, and the slot is given back.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(response.status).toBe(504)
    expect(fetchMock).not.toHaveBeenCalled()
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM "ai_invocations"`,
    ).first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })

  it("releases a reservation whose admission write landed after the budget", async () => {
    const session = await ownerSession()
    const created = await call("/api/auth/api-key/create", {
      body: {
        modelIds: [externalModelId],
        name: "admission probe",
        purpose: "ai",
      },
      headers: { cookie: session.cookie },
    })
    expect(created.status).toBe(200)
    const { key } = await created.json<{ key: string }>()

    const realNow = Date.now()
    const nowMock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow + clock.offsetMs)
    const realPrepare = env.DB.prepare.bind(env.DB)
    const prepareMock = vi
      .spyOn(env.DB, "prepare")
      .mockImplementation((sql: string) =>
        makeReservationWriteLate(sql, realPrepare(sql)),
      )
    const fetchMock = vi.spyOn(globalThis, "fetch")
    try {
      const response = await call("/api/ai/responses", {
        body: { input: "hi", model: externalModelId },
        headers: { "x-api-key": key },
      })
      // The reservation was admitted inside the budget, but its write landed
      // after it: the request is refused instead of starting the call.
      expect(response.status).toBe(504)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      prepareMock.mockRestore()
      nowMock.mockRestore()
      fetchMock.mockRestore()
    }

    // The slot is given back: no reservation survives the refused request.
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM "ai_invocations"`,
    ).first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })
})

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { expect, it } from "vitest"

import worker from "../../src/worker"
import { instrumentDatabase } from "./fixtures/session"
it("returns 503 and never authenticates after a late limiter response", async () => {
  let release!: (v: { success: boolean }) => void
  let entered!: () => void
  let queries = 0
  const afterAuthentication = new Promise<void>((r) => (entered = r))
  const limiter = {
    limit: () => new Promise<{ success: boolean }>((r) => (release = r)),
  } as RateLimit
  const db = instrumentDatabase(env.DB, () => {
    queries++
    entered()
  })
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(env.APP_ORIGIN + "/api/status", {
      headers: { "x-api-key": "eruoo_" + "x".repeat(64) },
    }),
    { ...env, DB: db, API_KEY_RATE_LIMITER: limiter },
    ctx,
  )
  expect(response.status).toBe(503)
  expect(queries).toBe(0)
  release({ success: true })
  await Promise.race([
    afterAuthentication,
    new Promise<void>((r) => setTimeout(r, 1000)),
  ])
  expect(queries).toBe(0)
  await new Promise((r) => setTimeout(r, 50))
  await waitOnExecutionContext(ctx)
}, 8000)

it("includes a successful limiter's latency in the total read deadline", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let queries = 0
  const db = instrumentDatabase(env.DB, async () => {
    queries++
    await gate
  })
  const limiter = {
    limit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return { success: true }
    },
  } as RateLimit
  const ctx = createExecutionContext()
  const started = Date.now()
  try {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + "/api/status", {
        headers: { "x-api-key": "eruoo_" + "x".repeat(64) },
      }),
      { ...env, DB: db, API_KEY_RATE_LIMITER: limiter },
      ctx,
    )
    expect(response.status).toBe(504)
    expect(queries).toBeGreaterThan(0)
    expect(Date.now() - started).toBeLessThan(5500)
  } finally {
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitOnExecutionContext(ctx)
  }
}, 8000)

import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker/index"
import { instrumentDatabase, ownerSession } from "./fixtures/session"

afterEach(() => vi.restoreAllMocks())
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user").run()
})

async function request(path: string, cookie?: string, database = env.DB) {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`http://local.test${path}`, {
      headers: cookie ? { cookie } : {},
    }),
    { ...env, DB: database },
    context,
  )
  await waitOnExecutionContext(context)
  return response
}

describe("Session authority and request isolation", () => {
  it("renews only after 24h, preserves recent authentication and serves JWE without D1", async () => {
    const fixture = await ownerSession({
      updatedAt: new Date(Date.now() - 2 * 86400000),
      expiresAt: new Date(Date.now() + 28 * 86400000),
    })
    const before = await env.DB.prepare("SELECT * FROM session WHERE id=?")
      .bind(fixture.id)
      .first<{ reauthenticatedAt: string; expiresAt: string }>()
    let queries = 0
    const database = instrumentDatabase(env.DB, () => {
      queries++
    })
    const response = await request(
      "/api/auth/get-session",
      fixture.cookie,
      database,
    )
    expect(response.status).toBe(200)
    expect(queries).toBe(2)
    const cookies = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
    expect(cookies).toContain("eruoo.session_data=")
    const after = await env.DB.prepare("SELECT * FROM session WHERE id=?")
      .bind(fixture.id)
      .first<{ reauthenticatedAt: string; expiresAt: string }>()
    expect(after?.reauthenticatedAt).toBe(before?.reauthenticatedAt)
    expect(new Date(after!.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 86400000,
    )
    queries = 0
    expect(
      (await request("/api/auth/get-session", cookies, database)).status,
    ).toBe(200)
    expect(queries).toBe(0)
    queries = 0
    await request("/api/auth/get-session", fixture.cookie, database)
    expect(queries).toBe(1)
  })

  it("does not turn a dependency failure into an anonymous Session", async () => {
    const fixture = await ownerSession()
    const database = instrumentDatabase(env.DB, () => {
      throw new Error("synthetic D1 failure")
    })
    const response = await request(
      "/api/auth/get-session",
      fixture.cookie,
      database,
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 503 })
  })

  it("does not renew expired persistent Sessions", async () => {
    const fixture = await ownerSession({
      expiresAt: new Date(Date.now() - 1000),
    })
    const response = await request("/api/auth/get-session", fixture.cookie)
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
  })

  it("bounds the first blocked read while a second request reaches D1 independently", async () => {
    const fixture = await ownerSession()
    let entered!: () => void
    let release!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let queries = 0
    const database = instrumentDatabase(env.DB, async () => {
      if (++queries === 1) {
        entered()
        await blocked
      }
    })
    const started = Date.now()
    const first = request("/api/auth/get-session", fixture.cookie, database)
    await firstEntered
    try {
      const second = await request(
        "/api/auth/get-session",
        fixture.cookie,
        database,
      )
      expect(second.status).toBe(200)
      expect(queries).toBe(2)
      expect(Date.now() - started).toBeLessThan(1000)
      expect((await first).status).toBe(504)
      expect(Date.now() - started).toBeLessThan(5500)
    } finally {
      release()
      await first
    }
  }, 8000)

  it("rejects arbitrary paths and methods before any D1 access; error landing stays available", async () => {
    let queries = 0
    const database = instrumentDatabase(env.DB, () => {
      queries++
      throw new Error("D1 must not be used")
    })
    for (let i = 0; i < 105; i++)
      expect(
        (await request(`/api/auth/unknown-${i}`, undefined, database)).status,
      ).toBe(404)
    for (const path of [
      "/api/auth/get-session/",
      "/api/auth/%67et-session",
      "/api/auth/sign-up/email",
    ])
      expect((await request(path, undefined, database)).status).toBe(404)
    const response = await request(
      "/api/auth/error?error=state_not_found&error_description=secret",
      undefined,
      database,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "/login?error=state_not_found",
    )
    expect(queries).toBe(0)
  })
})

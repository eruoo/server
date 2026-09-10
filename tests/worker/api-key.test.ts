import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { describe, expect, it } from "vitest"

import worker from "../../src/worker"
import { ownerSession } from "./fixtures/session"
let sequence = 0
async function request(
  path: string,
  cookie?: string,
  body?: unknown,
  customEnv = env,
) {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: env.APP_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": `key-test-${++sequence}`,
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    customEnv,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}
describe("API key contract", () => {
  it("creates finite scoped keys, never exposes their secret in lists, and deletes them", async () => {
    const session = await ownerSession()
    const created = await request("/api/auth/api-key/create", session.cookie, {
      name: "status probe",
      expiresIn: 86400,
    })
    expect(created.status).toBe(200)
    const key = await created.json<{ id: string; key: string }>()
    expect(key.key).toMatch(/^eruoo_/)
    const ctx = createExecutionContext()
    const status = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/api/status`, {
        headers: { "x-api-key": key.key, "cf-connecting-ip": "status-one" },
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(status.status).toBe(200)
    expect(status.headers.get("api-key-expires-at")).toBeTruthy()
    const list = await request("/api/auth/api-key/list", session.cookie)
    expect(list.status).toBe(200)
    expect(await list.text()).not.toContain(key.key)
    expect(
      (
        await request("/api/auth/api-key/update", session.cookie, {
          keyId: key.id,
          expiresIn: null,
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await request("/api/auth/api-key/delete", session.cookie, {
          keyId: key.id,
        })
      ).status,
    ).toBe(200)
  })
  it("reports a database failure as 503 rather than an invalid key", async () => {
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.toLowerCase().includes("apikey"))
              throw new Error("synthetic database outage")
            return target.prepare(sql)
          }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request(`${env.APP_ORIGIN}/api/status`, {
        headers: {
          "x-api-key": "eruoo_" + "x".repeat(64),
          "cf-connecting-ip": "outage-key",
        },
      }),
      { ...env, DB: database },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(503)
  })
})

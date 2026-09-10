import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, afterEach, it, expect, vi } from "vitest"

import worker from "../../src/worker"
import { ownerSession } from "./fixtures/session"
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user").run()
})
afterEach(() => vi.useRealTimers())
async function call(
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(env.APP_ORIGIN + path, {
      method: body ? "POST" : "GET",
      headers: {
        origin: env.APP_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": crypto.randomUUID(),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    context,
  )
  await waitOnExecutionContext(context)
  return response
}
it("keeps cached identity encrypted on the wire", async () => {
  const fixture = await ownerSession()
  const response = await call("/api/auth/get-session", {
    cookie: fixture.cookie,
  })
  const cookie = response.headers
    .getSetCookie()
    .find((v) => v.startsWith("eruoo.session_data="))!
  expect(
    decodeURIComponent(
      cookie.split(";")[0]!.slice("eruoo.session_data=".length),
    ).split("."),
  ).toHaveLength(5)
})
it("stops trusting revoked cached identity after 30 seconds", async () => {
  const fixture = await ownerSession()
  const response = await call("/api/auth/get-session", {
    cookie: fixture.cookie,
  })
  const cookie = [
    fixture.cookie,
    ...response.headers
      .getSetCookie()
      .filter((v) => v.startsWith("eruoo.session_data="))
      .map((v) => v.split(";")[0]),
  ].join("; ")
  await env.DB.prepare("DELETE FROM session WHERE id=?").bind(fixture.id).run()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + 31_000)
  const read = await call("/api/auth/get-session", { cookie })
  expect(read.status).toBe(200)
  expect(await read.json()).toBeNull()
})
async function keyFixture() {
  const session = await ownerSession()
  const response = await call(
    "/api/auth/api-key/create",
    { cookie: session.cookie },
    { name: "counterexample", expiresIn: 86400 },
  )
  expect(response.status).toBe(200)
  return response.json<{ id: string; key: string }>()
}
it("rejects a persisted key without status permission", async () => {
  const key = await keyFixture()
  await env.DB.prepare("UPDATE apikey SET permissions=? WHERE id=?")
    .bind("{}", key.id)
    .run()
  const response = await call("/api/status", { "x-api-key": key.key })
  expect(response.status).toBe(403)
})
it("rejects a persisted key whose owner account association is gone", async () => {
  const key = await keyFixture()
  await env.DB.prepare("DELETE FROM account").run()
  const response = await call("/api/status", { "x-api-key": key.key })
  expect(response.status).toBe(401)
})

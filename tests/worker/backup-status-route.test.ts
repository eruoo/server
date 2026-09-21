import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { oauthFetch } from "./fixtures/oauth"
import { instrumentDatabase, ownerSession } from "./fixtures/session"

const path = "/api/security/backup-status"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM database_backup_health"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM user"),
  ])
})

describe("backup status route", () => {
  it("rejects anonymous access and mixed credential carriers", async () => {
    expect((await oauthFetch(path)).status).toBe(401)
    const session = await ownerSession()
    const mixed = await oauthFetch(path, {
      headers: { cookie: session.cookie, authorization: "Bearer abc" },
    })
    expect(mixed.status).toBe(400)
  })

  it("reports the never-run terminal state for an empty health table", async () => {
    const session = await ownerSession()
    const response = await oauthFetch(path, {
      headers: { cookie: session.cookie },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    })
  })

  it("maps a corrupted stored health row to an internal error", async () => {
    const session = await ownerSession()
    const now = Date.now()
    await env.DB.prepare(
      "INSERT INTO database_backup_health (name,status,runId,startedAt,completedAt,lastSuccessAt,failureCode) VALUES ('database-backup','ok','',?,?,?,NULL)",
    )
      .bind(now, now, now)
      .run()
    const response = await oauthFetch(path, {
      headers: { cookie: session.cookie },
    })
    expect(response.status).toBe(500)
    expect(await response.json<{ type?: string }>()).toMatchObject({
      type: "https://auth.eruoo.me/problems/internal-error",
    })
  })

  it("keeps dependency failures distinguishable from missing credentials", async () => {
    const session = await ownerSession()
    const unavailable = instrumentDatabase(env.DB, () => {
      throw new Error("D1 unavailable")
    })
    const response = await oauthFetch(
      path,
      { headers: { cookie: session.cookie } },
      unavailable,
    )
    expect(response.status).toBe(503)
  })
})

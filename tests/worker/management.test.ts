import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  listAuditEvents,
  InvalidAuditCursorError,
} from "../../src/worker/modules/audit/repository"
import { cleanupExpiredRecords } from "../../src/worker/schedules"
import { ownerSession } from "./fixtures/session"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM security_audit_events"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})

describe("management authorization", () => {
  it("rejects mixed carriers before D1 and accepts owner Passkey list", async () => {
    const fixture = await ownerSession()
    const response = await SELF.fetch(
      "http://local.test/api/auth/passkey/list-user-passkeys",
      { headers: { cookie: fixture.cookie } },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
    const mixed = await SELF.fetch(
      "http://local.test/api/security/audit-events",
      { headers: { cookie: fixture.cookie, authorization: "Bearer abc" } },
    )
    expect(mixed.status).toBe(400)
    const wrongCarrier = await SELF.fetch(
      "http://local.test/api/security/audit-events",
      { headers: { "x-api-key": "valid-looking-key" } },
    )
    expect(wrongCarrier.status).toBe(403)
  })

  it("requires persistent recent authentication for registration, including future and revoked sessions", async () => {
    const fixture = await ownerSession()
    for (const offset of [-16 * 60000, 60000]) {
      await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
        .bind(new Date(Date.now() + offset).toISOString(), fixture.id)
        .run()
      const response = await SELF.fetch(
        "http://local.test/api/auth/passkey/generate-register-options",
        { headers: { cookie: fixture.cookie, origin: "http://local.test" } },
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        type: "https://auth.eruoo.me/problems/recent-authentication-required",
      })
    }
    await env.DB.prepare("DELETE FROM session WHERE id=?")
      .bind(fixture.id)
      .run()
    const revoked = await SELF.fetch(
      "http://local.test/api/auth/passkey/generate-register-options",
      { headers: { cookie: fixture.cookie, origin: "http://local.test" } },
    )
    expect(revoked.status).toBe(401)
  })

  it("serves registration options only for a recently authenticated owner", async () => {
    const fixture = await ownerSession()
    const response = await SELF.fetch(
      "http://local.test/api/auth/passkey/generate-register-options",
      { headers: { cookie: fixture.cookie, origin: "http://local.test" } },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      rp: { id: "local.test" },
      authenticatorSelection: { userVerification: "required" },
    })
  })
})

describe("audit and cleanup", () => {
  it("paginates tied timestamps without overlap and rejects a cursor used with other filters", async () => {
    const now = Date.now()
    await env.DB.batch(
      ["a", "b", "c"].map((id) =>
        env.DB.prepare(
          "INSERT INTO security_audit_events (id,type,outcome,occurredAt,requestId) VALUES (?,'passkey_created','success',?,?)",
        ).bind(id, now, id),
      ),
    )
    const first = await listAuditEvents(env.DB, env.AUDIT_IP_HASH_SECRET, {
      limit: 2,
    })
    const second = await listAuditEvents(env.DB, env.AUDIT_IP_HASH_SECRET, {
      cursor: first.nextCursor!,
      limit: 2,
    })
    expect(first.events.map((event) => event.id)).toEqual(["c", "b"])
    expect(second.events.map((event) => event.id)).toEqual(["a"])
    await expect(
      listAuditEvents(env.DB, env.AUDIT_IP_HASH_SECRET, {
        cursor: first.nextCursor!,
        outcome: "failure",
      }),
    ).rejects.toBeInstanceOf(InvalidAuditCursorError)
  })

  it("cleans only expired maintenance records and never deletes Session rows", async () => {
    const fixture = await ownerSession({
      expiresAt: new Date(Date.now() - 1000),
    })
    const now = Date.now()
    await env.DB.prepare(
      "INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES ('expired','expired','{}',?1,?1,?1)",
    )
      .bind(new Date(now - 1).toISOString())
      .run()
    await cleanupExpiredRecords(env.DB, now)
    await cleanupExpiredRecords(env.DB, now)
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM session WHERE id=?")
        .bind(fixture.id)
        .first("n"),
    ).toBe(1)
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM verification WHERE id='expired'",
      ).first("n"),
    ).toBe(0)
  })
})

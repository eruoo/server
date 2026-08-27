import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { createOwnerSession } from "./fixtures/owner-session"

const applicationOrigin = "http://localhost:5173"

interface AuditRow {
  outcome: string
  subjectId: string | null
  type: string
}

async function latestAudit(type: string): Promise<AuditRow | null> {
  return env.DB.prepare(
    `SELECT outcome, subjectId, type
     FROM security_audit_events
     WHERE type = ?1
     ORDER BY occurredAt DESC
     LIMIT 1`,
  )
    .bind(type)
    .first<AuditRow>()
}

describe("Passkey endpoint auditing", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM verification"),
      env.DB.prepare("DELETE FROM passkey"),
      env.DB.prepare("DELETE FROM apikey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM rateLimit"),
    ])
  })

  it.each([
    ["verify-registration", "passkey_created"],
    ["update-passkey", "passkey_updated"],
    ["delete-passkey", "passkey_deleted"],
  ] as const)(
    "audits a failed authenticated %s request as %s",
    async (operation, eventType) => {
      const cookie = await createOwnerSession()
      const owner = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
        id: string
      }>()

      if (!owner) {
        throw new Error("Synthetic owner fixture was not created.")
      }

      const response = await SELF.fetch(
        `http://local.test/api/auth/passkey/${operation}`,
        {
          body: "{}",
          headers: {
            "content-type": "application/json",
            cookie: `eruoo.session_token=${cookie}`,
            origin: applicationOrigin,
          },
          method: "POST",
        },
      )

      expect(response.status).toBeGreaterThanOrEqual(400)
      await expect(latestAudit(eventType)).resolves.toEqual({
        outcome: "failure",
        subjectId: owner.id,
        type: eventType,
      })
    },
  )

  it("audits a failed public authentication request as passkey_login", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/passkey/verify-authentication",
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: applicationOrigin,
        },
        method: "POST",
      },
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
    await expect(latestAudit("passkey_login")).resolves.toEqual({
      outcome: "failure",
      subjectId: null,
      type: "passkey_login",
    })
  })
})

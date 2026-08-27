import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { recordAuditEvent } from "../../src/worker/audit"

describe("security audit storage", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM security_audit_events").run()
  })

  it("stores epoch milliseconds and a keyed IP fingerprint", async () => {
    const ipAddress = "203.0.113.10"

    await recordAuditEvent(
      {
        AUDIT_IP_HASH_SECRET:
          "synthetic-audit-secret-used-only-in-worker-tests",
        DB: env.DB,
      },
      ipAddress,
      "audit-test-request",
      {
        outcome: "success",
        type: "passkey_created",
      },
    )

    const row = await env.DB.prepare(
      `SELECT occurredAt, ipFingerprint, requestId
       FROM security_audit_events
       LIMIT 1`,
    ).first<{
      ipFingerprint: string
      occurredAt: number
      requestId: string
    }>()

    expect(row).not.toBeNull()
    expect(row?.requestId).toBe("audit-test-request")
    expect(row?.occurredAt).toEqual(expect.any(Number))
    expect(row?.occurredAt).toBeLessThanOrEqual(Date.now())
    expect(row?.ipFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(row?.ipFingerprint).not.toContain(ipAddress)
  })

  it("rejects an undersized audit HMAC secret before writing", async () => {
    await expect(
      recordAuditEvent(
        { AUDIT_IP_HASH_SECRET: "too-short", DB: env.DB },
        null,
        "audit-test-request",
        { outcome: "failure", type: "security_configuration_changed" },
      ),
    ).rejects.toThrow("at least 32 UTF-8 bytes")

    const row = await env.DB.prepare(
      "SELECT id FROM security_audit_events LIMIT 1",
    ).first()
    expect(row).toBeNull()
  })
})

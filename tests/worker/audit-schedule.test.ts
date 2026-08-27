import { createScheduledController, env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import { deleteExpiredVerifications } from "../../src/worker/auth/verification-cleanup"
import { DAILY_CLEANUP_SCHEDULE } from "../../src/worker/schedules"

const now = 2_000_000_000_000
const day = 24 * 60 * 60 * 1000

async function insertAuditEvent(id: string, occurredAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO security_audit_events
      (id, type, outcome, occurredAt, requestId)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, "passkey_created", "success", occurredAt, `request-${id}`)
    .run()
}

async function storedEventIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM security_audit_events ORDER BY id",
  ).all<{ id: string }>()

  return rows.results.map(({ id }) => id)
}

async function insertVerification(
  id: string,
  expiresAt: number,
): Promise<void> {
  const createdAt = new Date(now).toISOString()
  await env.DB.prepare(
    `INSERT INTO verification
      (id, identifier, value, expiresAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `identifier-${id}`,
      `value-${id}`,
      new Date(expiresAt).toISOString(),
      createdAt,
      createdAt,
    )
    .run()
}

async function storedVerificationIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM verification ORDER BY id",
  ).all<{ id: string }>()

  return rows.results.map(({ id }) => id)
}

describe("audit cleanup schedule", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM verification"),
    ])
    vi.restoreAllMocks()
  })

  it("deletes only events older than 180 days for the configured cron", async () => {
    await insertAuditEvent("boundary", now - 180 * day)
    await insertAuditEvent("expired", now - 180 * day - 1)

    await worker.scheduled(
      createScheduledController({
        cron: DAILY_CLEANUP_SCHEDULE,
        scheduledTime: now,
      }),
      env,
    )

    await expect(storedEventIds()).resolves.toEqual(["boundary"])
  })

  it("deletes only expired temporary verification records", async () => {
    await insertVerification("boundary", now)
    await insertVerification("expired", now - 1)
    await insertVerification("live", now + 1)

    await worker.scheduled(
      createScheduledController({
        cron: DAILY_CLEANUP_SCHEDULE,
        scheduledTime: now,
      }),
      env,
    )

    await expect(storedVerificationIds()).resolves.toEqual(["boundary", "live"])
  })

  it("uses the expiration index for verification cleanup", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       DELETE FROM verification
       WHERE expiresAt < ?`,
    )
      .bind(new Date(now).toISOString())
      .all<{ detail: string }>()
    const details = plan.results.map(({ detail }) => detail).join("\n")

    expect(details).toContain("verification_expiresAt_idx")
    expect(details).not.toContain("SCAN verification")
  })

  it("rejects an invalid cleanup boundary without deleting records", async () => {
    await insertVerification("expired", now - 1)

    await expect(
      deleteExpiredVerifications(env.DB, Number.NaN),
    ).rejects.toThrow("verification cleanup boundary is invalid")
    await expect(storedVerificationIds()).resolves.toEqual(["expired"])
  })

  it("ignores an unrecognized scheduled trigger", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    await insertAuditEvent("expired", now - 180 * day - 1)
    await insertVerification("expired", now - 1)

    await worker.scheduled(
      createScheduledController({
        cron: "0 0 * * *",
        scheduledTime: now,
      }),
      env,
    )

    await expect(storedEventIds()).resolves.toEqual(["expired"])
    await expect(storedVerificationIds()).resolves.toEqual(["expired"])
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "0 0 * * *",
        event: "unknown_scheduled_trigger",
      }),
    )
  })
})

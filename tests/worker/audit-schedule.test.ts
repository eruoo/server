import { createScheduledController, env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import { deleteExpiredVerifications } from "../../src/worker/auth/verification-cleanup"
import {
  DAILY_CLEANUP_SCHEDULE,
  DATABASE_BACKUP_SCHEDULE,
} from "../../src/worker/schedules"

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

function environmentWithWorkflowCreateBatch(
  createBatch: Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"],
): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DATABASE_BACKUP_WORKFLOW") return { createBatch }
      return Reflect.get(target, property, receiver)
    },
  })
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

  it("starts only the backup Workflow for the weekly backup cron", async () => {
    const createBatch = vi.fn<Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"]>(
      async () =>
        [{ id: "database-backup-v1-2000000000000" }] as WorkflowInstance[],
    )
    const information = vi.spyOn(console, "info").mockImplementation(() => {})
    await insertAuditEvent("expired", now - 180 * day - 1)
    await insertVerification("expired", now - 1)

    await worker.scheduled(
      createScheduledController({
        cron: DATABASE_BACKUP_SCHEDULE,
        scheduledTime: now,
      }),
      environmentWithWorkflowCreateBatch(createBatch),
    )

    expect(createBatch).toHaveBeenCalledTimes(1)
    expect(createBatch).toHaveBeenCalledWith([
      { id: "database-backup-v1-2000000000000" },
    ])
    await expect(storedEventIds()).resolves.toEqual(["expired"])
    await expect(storedVerificationIds()).resolves.toEqual(["expired"])
    expect(information).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "database_backup_workflow_started",
        instanceId: "database-backup-v1-2000000000000",
        scheduledTime: now,
      }),
    )
  })

  it("treats a duplicate backup schedule delivery as already started", async () => {
    const createBatch = vi.fn<Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"]>(
      async () => [],
    )
    const information = vi.spyOn(console, "info").mockImplementation(() => {})

    await worker.scheduled(
      createScheduledController({
        cron: DATABASE_BACKUP_SCHEDULE,
        scheduledTime: now,
      }),
      environmentWithWorkflowCreateBatch(createBatch),
    )

    expect(createBatch).toHaveBeenCalledWith([
      { id: "database-backup-v1-2000000000000" },
    ])
    expect(information).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "database_backup_workflow_duplicate_skipped",
        instanceId: "database-backup-v1-2000000000000",
        scheduledTime: now,
      }),
    )
  })

  it("does not start the backup Workflow during daily cleanup", async () => {
    const createBatch = vi.fn<Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"]>()

    await worker.scheduled(
      createScheduledController({
        cron: DAILY_CLEANUP_SCHEDULE,
        scheduledTime: now,
      }),
      environmentWithWorkflowCreateBatch(createBatch),
    )

    expect(createBatch).not.toHaveBeenCalled()
  })

  it("reports and propagates a backup Workflow start failure", async () => {
    const failure = new Error("synthetic Workflow start failure")
    const createBatch = vi.fn<Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"]>(
      async () => Promise.reject(failure),
    )
    const logging = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(
      worker.scheduled(
        createScheduledController({
          cron: DATABASE_BACKUP_SCHEDULE,
          scheduledTime: now,
        }),
        environmentWithWorkflowCreateBatch(createBatch),
      ),
    ).rejects.toBe(failure)
    expect(logging).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Error",
        event: "database_backup_schedule_failed",
        scheduledTime: now,
      }),
    )
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
    const createBatch = vi.fn<Env["DATABASE_BACKUP_WORKFLOW"]["createBatch"]>()
    await insertAuditEvent("expired", now - 180 * day - 1)
    await insertVerification("expired", now - 1)

    await worker.scheduled(
      createScheduledController({
        cron: "0 0 * * *",
        scheduledTime: now,
      }),
      environmentWithWorkflowCreateBatch(createBatch),
    )

    await expect(storedEventIds()).resolves.toEqual(["expired"])
    await expect(storedVerificationIds()).resolves.toEqual(["expired"])
    expect(createBatch).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "0 0 * * *",
        event: "unknown_scheduled_trigger",
      }),
    )
  })
})

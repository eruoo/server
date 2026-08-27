import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  getDatabaseBackupStatus,
  InvalidDatabaseBackupTerminalStateError,
  recordDatabaseBackupTerminalState,
} from "../../src/worker/backup/health"

const baseStartedAt = 2_000_000_000_000

describe("durable database backup health", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM database_backup_health").run()
  })

  it("returns never-run before a Workflow reaches a terminal state", async () => {
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    })
  })

  it("persists a failure and clears it when a newer success arrives", async () => {
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 10_000,
      failureCode: "backup_upload_failed",
      runId: "workflow-failed",
      startedAt: baseStartedAt,
      status: "failed",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_upload_failed",
      lastAttemptAt: baseStartedAt + 10_000,
      lastSuccessAt: null,
      status: "failed",
    })

    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 30_000,
      runId: "workflow-succeeded",
      startedAt: baseStartedAt + 20_000,
      status: "ok",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: null,
      lastAttemptAt: baseStartedAt + 30_000,
      lastSuccessAt: baseStartedAt + 30_000,
      status: "ok",
    })

    const stored = await env.DB.prepare(
      `SELECT failureCode
       FROM database_backup_health
       WHERE name = 'database-backup'`,
    ).first<{ failureCode: string | null }>()

    expect(stored?.failureCode).toBeNull()
  })

  it("preserves the last success when a newer run fails", async () => {
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 10_000,
      runId: "workflow-succeeded",
      startedAt: baseStartedAt,
      status: "ok",
    })
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 30_000,
      failureCode: "backup_export_timed_out",
      runId: "workflow-failed",
      startedAt: baseStartedAt + 20_000,
      status: "failed",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_export_timed_out",
      lastAttemptAt: baseStartedAt + 30_000,
      lastSuccessAt: baseStartedAt + 10_000,
      status: "failed",
    })
  })

  it("does not let an older Workflow overwrite the latest terminal state", async () => {
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 30_000,
      failureCode: "backup_export_failed",
      runId: "workflow-newer",
      startedAt: baseStartedAt + 20_000,
      status: "failed",
    })
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 10_000,
      runId: "workflow-older",
      startedAt: baseStartedAt,
      status: "ok",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_export_failed",
      lastAttemptAt: baseStartedAt + 30_000,
      lastSuccessAt: baseStartedAt + 10_000,
      status: "failed",
    })
  })

  it("uses completion time within one start time before applying the success tie-break", async () => {
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 20_000,
      failureCode: "backup_upload_failed",
      runId: "workflow-later-completion",
      startedAt: baseStartedAt,
      status: "failed",
    })
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 10_000,
      runId: "workflow-earlier-completion",
      startedAt: baseStartedAt,
      status: "ok",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toMatchObject({
      errorCode: "backup_upload_failed",
      lastAttemptAt: baseStartedAt + 20_000,
      status: "failed",
    })

    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: baseStartedAt + 20_000,
      runId: "workflow-success-tie",
      startedAt: baseStartedAt,
      status: "ok",
    })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: null,
      lastAttemptAt: baseStartedAt + 20_000,
      lastSuccessAt: baseStartedAt + 20_000,
      status: "ok",
    })
  })

  it("chooses success deterministically for an exact timestamp tie", async () => {
    const failure = {
      completedAt: baseStartedAt + 10_000,
      failureCode: "backup_upload_failed" as const,
      runId: "workflow-z",
      startedAt: baseStartedAt,
      status: "failed" as const,
    }
    const success = {
      completedAt: baseStartedAt + 10_000,
      runId: "workflow-a",
      startedAt: baseStartedAt,
      status: "ok" as const,
    }

    await recordDatabaseBackupTerminalState(env.DB, failure)
    await recordDatabaseBackupTerminalState(env.DB, success)
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toMatchObject({
      status: "ok",
    })

    await env.DB.prepare("DELETE FROM database_backup_health").run()
    await recordDatabaseBackupTerminalState(env.DB, success)
    await recordDatabaseBackupTerminalState(env.DB, failure)
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toMatchObject({
      status: "ok",
    })
  })

  it("rejects malformed terminal state before writing D1", async () => {
    await expect(
      recordDatabaseBackupTerminalState(env.DB, {
        completedAt: baseStartedAt - 1,
        runId: "workflow-invalid",
        startedAt: baseStartedAt,
        status: "ok",
      }),
    ).rejects.toBeInstanceOf(InvalidDatabaseBackupTerminalStateError)

    await expect(
      recordDatabaseBackupTerminalState(env.DB, {
        completedAt: 8_640_000_000_000_001,
        runId: "workflow-outside-date-range",
        startedAt: 8_640_000_000_000_001,
        status: "ok",
      }),
    ).rejects.toBeInstanceOf(InvalidDatabaseBackupTerminalStateError)

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toMatchObject({
      status: "never-run",
    })
  })
})

import { env } from "cloudflare:test"
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  D1_EXPORT_MAX_POLL_DURATION_MS,
  D1_EXPORT_MAX_POLL_OBSERVATIONS,
  D1_EXPORT_POLL_INTERVAL_MS,
} from "../../src/worker/backup/constants"
import type { BackupFetch } from "../../src/worker/backup/d1-export"
import { DatabaseBackupError } from "../../src/worker/backup/errors"
import {
  getDatabaseBackupStatus,
  recordDatabaseBackupTerminalState,
} from "../../src/worker/backup/health"
import {
  createDurableExportOperations,
  DatabaseBackupWorkflow,
  type DatabaseBackupWorkflowResult,
  POLL_EXPORT_STEP_CONFIG,
  recordDatabaseBackupExecutionStart,
  recordDatabaseBackupWorkflowTerminalTime,
  recordDatabaseBackupWorkflowTerminalState,
  START_EXPORT_STEP_CONFIG,
  UPLOAD_STEP_CONFIG,
} from "../../src/worker/workflows/database-backup"

const accountId = "a".repeat(32)
const databaseId = "00000000-0000-4000-8000-000000000001"
const apiToken = "synthetic-test-token"
const workersFreeExternalSubrequestLimit = 50

type StepDo = (
  name: string,
  config: WorkflowStepConfig,
  callback: () => Promise<unknown>,
) => Promise<unknown>

function workflowStep(doStep: StepDo): WorkflowStep {
  return { do: doStep } as unknown as WorkflowStep
}

function exportEnvironment() {
  return {
    CF_ACCOUNT_ID: accountId,
    D1_DATABASE_ID: databaseId,
    D1_EXPORT_API_TOKEN: apiToken,
  }
}

function databaseBackupWorkflowEnvironment() {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "CF_ACCOUNT_ID") return accountId
      if (property === "CF_VERSION_METADATA") {
        return {
          id: "synthetic-workflow-version",
          tag: "synthetic-workflow-tag",
          timestamp: "2033-05-18T03:20:00.000Z",
        }
      }
      if (property === "D1_DATABASE_ID") return databaseId
      if (property === "D1_EXPORT_API_TOKEN") return apiToken

      return Reflect.get(target, property, receiver)
    },
  })
}

function databaseBackupWorkflowEvent(
  instanceId: string,
  timestamp: Date,
): WorkflowEvent<unknown> {
  return {
    instanceId,
    payload: {},
    timestamp,
    workflowName: "database-backup",
  }
}

async function holdDatabaseBackupLease(
  ownerId: string,
  expiresAt: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO maintenance_lease (name, ownerId, expiresAt)
     VALUES ('database-backup', ?1, ?2)`,
  )
    .bind(ownerId, expiresAt)
    .run()
}

function runDatabaseBackupWorkflow(
  event: WorkflowEvent<unknown>,
  doStep: StepDo,
): Promise<DatabaseBackupWorkflowResult> {
  return Reflect.apply(
    DatabaseBackupWorkflow.prototype.run,
    { env: databaseBackupWorkflowEnvironment() },
    [event, workflowStep(doStep)],
  ) as Promise<DatabaseBackupWorkflowResult>
}

describe("database backup Workflow durability", () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await env.DB.prepare("DELETE FROM database_backup_health").run()
    await env.DB.prepare("DELETE FROM maintenance_lease").run()
  })

  it("keeps the worst-case external request budget below Workers Free", () => {
    expect(POLL_EXPORT_STEP_CONFIG.retries.limit).toBe(2)
    expect(UPLOAD_STEP_CONFIG.retries.limit).toBe(2)

    const configuredMaximum =
      START_EXPORT_STEP_CONFIG.retries.limit +
      D1_EXPORT_MAX_POLL_OBSERVATIONS * POLL_EXPORT_STEP_CONFIG.retries.limit +
      UPLOAD_STEP_CONFIG.retries.limit

    expect(
      D1_EXPORT_MAX_POLL_DURATION_MS -
        D1_EXPORT_MAX_POLL_OBSERVATIONS * D1_EXPORT_POLL_INTERVAL_MS,
    ).toBeGreaterThanOrEqual(60_000)
    expect(configuredMaximum).toBe(33)
    expect(
      workersFreeExternalSubrequestLimit - configuredMaximum,
    ).toBeGreaterThanOrEqual(10)
  })

  it("persists the actual first-step time and reuses it during replay", async () => {
    vi.useFakeTimers()
    const actualExecutionStart = new Date("2033-05-18T03:20:00.000Z")
    vi.setSystemTime(actualExecutionStart)
    const persistedResults = new Map<string, unknown>()
    let callbackInvocations = 0
    const doStep = vi.fn<StepDo>(
      async (
        name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => {
        if (persistedResults.has(name)) return persistedResults.get(name)

        callbackInvocations += 1
        const result = await callback()
        persistedResults.set(name, result)
        return result
      },
    )
    const step = workflowStep(doStep)

    const firstRun = await recordDatabaseBackupExecutionStart(step)
    vi.setSystemTime(new Date("2033-05-18T04:20:00.000Z"))
    const replay = await recordDatabaseBackupExecutionStart(step)

    expect(firstRun).toBe(actualExecutionStart.getTime())
    expect(replay).toBe(firstRun)
    expect(callbackInvocations).toBe(1)
    expect(doStep).toHaveBeenCalledTimes(2)
    expect(doStep.mock.calls[0]?.[0]).toBe(
      "record database backup execution start",
    )
  })

  it.each([
    { existingStatus: "never-run", seedSuccess: false },
    { existingStatus: "ok", seedSuccess: true },
  ])(
    "does not publish a lease conflict when backup health is $existingStatus",
    async ({ seedSuccess }) => {
      vi.useFakeTimers()
      const successfulStartedAt = new Date("2033-05-18T03:20:00.000Z")
      const successfulCompletedAt = new Date("2033-05-18T03:21:00.000Z")
      const conflictingStartedAt = new Date("2033-05-18T03:25:00.000Z")
      vi.setSystemTime(conflictingStartedAt)
      if (seedSuccess) {
        await recordDatabaseBackupTerminalState(env.DB, {
          completedAt: successfulCompletedAt.getTime(),
          runId: "workflow-lease-holder",
          startedAt: successfulStartedAt.getTime(),
          status: "ok",
        })
      }
      await holdDatabaseBackupLease(
        "workflow-lease-holder",
        conflictingStartedAt.getTime() + 60_000,
      )
      const doStep = vi.fn<StepDo>(
        async (
          _name: string,
          _config: WorkflowStepConfig,
          callback: () => Promise<unknown>,
        ) => callback(),
      )

      await expect(
        runDatabaseBackupWorkflow(
          databaseBackupWorkflowEvent(
            "workflow-lease-loser",
            conflictingStartedAt,
          ),
          doStep,
        ),
      ).rejects.toMatchObject({ code: "backup_concurrency_conflict" })

      expect(doStep.mock.calls.map(([name]) => name)).toEqual([
        "record database backup execution start",
        "acquire database backup lease",
      ])
      await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual(
        seedSuccess
          ? {
              errorCode: null,
              lastAttemptAt: successfulCompletedAt.getTime(),
              lastSuccessAt: successfulCompletedAt.getTime(),
              status: "ok",
            }
          : {
              errorCode: null,
              lastAttemptAt: null,
              lastSuccessAt: null,
              status: "never-run",
            },
      )
    },
  )

  it("keeps backup health empty when the execution-start step fails", async () => {
    vi.useFakeTimers()
    const eventTimestamp = new Date("2033-05-18T03:00:00.000Z")
    vi.setSystemTime(new Date("2033-05-18T04:20:00.000Z"))
    const doStep = vi.fn<StepDo>(
      async (
        name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => {
        if (name === "record database backup execution start") {
          throw new Error("synthetic execution-start failure")
        }

        return callback()
      },
    )

    await expect(
      runDatabaseBackupWorkflow(
        databaseBackupWorkflowEvent(
          "workflow-execution-start-failure",
          eventTimestamp,
        ),
        doStep,
      ),
    ).rejects.toMatchObject({ code: "backup_configuration_invalid" })

    expect(doStep.mock.calls.map(([name]) => name)).toEqual([
      "record database backup execution start",
    ])
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    })
  })

  it("persists one terminal time across top-level Workflow replay", async () => {
    vi.useFakeTimers()
    const actualExecutionStart = new Date("2033-05-18T03:20:00.000Z")
    vi.setSystemTime(actualExecutionStart)
    const persistedResults = new Map<string, unknown>()
    let callbackInvocations = 0
    const doStep = vi.fn<StepDo>(
      async (
        name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => {
        if (persistedResults.has(name)) return persistedResults.get(name)

        callbackInvocations += 1
        const result = await callback()
        persistedResults.set(name, result)
        return result
      },
    )
    const step = workflowStep(doStep)
    const invalidRevisionEnvironment = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "CF_VERSION_METADATA") {
          return { id: "", tag: "", timestamp: "invalid" }
        }

        return Reflect.get(target, property, receiver)
      },
    })
    const event = {
      instanceId: "workflow-top-level-replay-test",
      payload: {},
      timestamp: actualExecutionStart,
      workflowName: "database-backup",
    } satisfies WorkflowEvent<unknown>

    await expect(
      Reflect.apply(
        DatabaseBackupWorkflow.prototype.run,
        { env: invalidRevisionEnvironment },
        [event, step],
      ),
    ).rejects.toMatchObject({ code: "backup_configuration_invalid" })
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_configuration_invalid",
      lastAttemptAt: actualExecutionStart.getTime(),
      lastSuccessAt: null,
      status: "failed",
    })

    vi.setSystemTime(new Date("2033-05-18T04:20:00.000Z"))
    await expect(
      Reflect.apply(
        DatabaseBackupWorkflow.prototype.run,
        { env: invalidRevisionEnvironment },
        [event, step],
      ),
    ).rejects.toMatchObject({ code: "backup_configuration_invalid" })

    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_configuration_invalid",
      lastAttemptAt: actualExecutionStart.getTime(),
      lastSuccessAt: null,
      status: "failed",
    })
    expect(callbackInvocations).toBe(3)
    expect(persistedResults.get("record database backup terminal time")).toBe(
      actualExecutionStart.getTime(),
    )
  })

  it("rejects an invalid persisted terminal time", async () => {
    const step = workflowStep(vi.fn<StepDo>(async () => 2_000_000_000_000 - 1))

    await expect(
      recordDatabaseBackupWorkflowTerminalTime(step, 2_000_000_000_000),
    ).rejects.toMatchObject({
      code: "backup_configuration_invalid",
      retryable: false,
    })
  })

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-positive or unsafe persisted start time: %s",
    async (persistedStart) => {
      const step = workflowStep(vi.fn<StepDo>(async () => persistedStart))

      await expect(
        recordDatabaseBackupExecutionStart(step),
      ).rejects.toMatchObject({
        code: "backup_configuration_invalid",
        retryable: false,
      })
    },
  )

  it("uses limit one as the sole no-retry control for starting an export", async () => {
    let callbackAttempts = 0
    const doStep = vi.fn<StepDo>(
      async (
        _name: string,
        config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => {
        let lastError: unknown
        const limit = config.retries?.limit ?? 1
        for (let attempt = 0; attempt < limit; attempt += 1) {
          callbackAttempts += 1
          try {
            return await callback()
          } catch (error) {
            lastError = error
          }
        }

        throw lastError
      },
    )
    const fetcher = vi.fn<BackupFetch>(async () => {
      throw new Error("synthetic uncertain export response")
    })
    const operations = createDurableExportOperations(
      workflowStep(doStep),
      exportEnvironment(),
      fetcher,
    )

    const error = await operations
      .observeStart(Date.now() + 60_000)
      .catch((failure: unknown) => failure)

    expect(START_EXPORT_STEP_CONFIG.retries.limit).toBe(1)
    expect(doStep.mock.calls[0]?.[1]).toBe(START_EXPORT_STEP_CONFIG)
    expect(callbackAttempts).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(DatabaseBackupError)
    expect(error).not.toBeInstanceOf(NonRetryableError)
    expect(error).toMatchObject({
      code: "backup_export_request_failed",
      retryable: true,
    })
  })

  it("keeps terminal poll failures non-retryable on retry-enabled steps", async () => {
    const doStep = vi.fn<StepDo>(
      async (
        _name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => callback(),
    )
    const fetcher = vi.fn<BackupFetch>(
      async () => new Response(null, { status: 401 }),
    )
    const operations = createDurableExportOperations(
      workflowStep(doStep),
      exportEnvironment(),
      fetcher,
    )

    const error = await operations
      .observePoll(0, "bookmark", Date.now() + 60_000)
      .catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(NonRetryableError)
    expect(doStep.mock.calls[0]?.[1]).toBe(POLL_EXPORT_STEP_CONFIG)
    expect(error).toMatchObject({
      message: "backup_export_authentication_failed",
      name: "DatabaseBackup/backup_export_authentication_failed",
    })
  })

  it("wires the upload retry budget into the durable upload step", async () => {
    const sql = "SELECT 1;"
    const signedUrl = "https://signed.example/database.sql"
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === signedUrl) {
        return new Response(sql, {
          headers: {
            "Content-Length": String(new TextEncoder().encode(sql).length),
          },
        })
      }

      return Response.json({
        result: {
          at_bookmark: "bookmark-1",
          result: {
            filename: "database.sql",
            signed_url: signedUrl,
          },
          status: "complete",
          success: true,
          type: "export",
        },
        success: true,
      })
    })
    vi.stubGlobal("fetch", fetcher)
    const doStep = vi.fn<StepDo>(
      async (
        _name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => callback(),
    )

    const result = await runDatabaseBackupWorkflow(
      databaseBackupWorkflowEvent(
        "workflow-upload-config-test",
        new Date("2033-05-18T03:20:00.000Z"),
      ),
      doStep,
    )

    const uploadCall = doStep.mock.calls.find(
      ([name]) => name === "stream full D1 export directly to R2",
    )
    await env.BACKUPS.delete(result.key)
    expect(uploadCall?.[1]).toBe(UPLOAD_STEP_CONFIG)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("persists a terminal result inside a retryable durable step", async () => {
    await env.DB.prepare("DELETE FROM database_backup_health").run()
    const doStep = vi.fn<StepDo>(
      async (
        _name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => callback(),
    )

    await recordDatabaseBackupWorkflowTerminalState(
      workflowStep(doStep),
      env.DB,
      {
        completedAt: 2_000_000_001_000,
        failureCode: "backup_export_timed_out",
        runId: "workflow-terminal-test",
        startedAt: 2_000_000_000_000,
        status: "failed",
      },
    )

    expect(doStep.mock.calls[0]?.[0]).toBe("record database backup failed")
    expect(doStep.mock.calls[0]?.[1].retries?.limit).toBe(2)
    await expect(getDatabaseBackupStatus(env.DB)).resolves.toEqual({
      errorCode: "backup_export_timed_out",
      lastAttemptAt: 2_000_000_001_000,
      lastSuccessAt: null,
      status: "failed",
    })
  })

  it("classifies a terminal-state D1 failure for Workflow retries", async () => {
    const unavailableDatabase = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return () => {
            throw new Error("synthetic D1 failure")
          }
        }

        return Reflect.get(target, property, receiver)
      },
    })
    const doStep = vi.fn<StepDo>(
      async (
        _name: string,
        _config: WorkflowStepConfig,
        callback: () => Promise<unknown>,
      ) => callback(),
    )

    await expect(
      recordDatabaseBackupWorkflowTerminalState(
        workflowStep(doStep),
        unavailableDatabase,
        {
          completedAt: 2_000_000_001_000,
          runId: "workflow-health-failure-test",
          startedAt: 2_000_000_000_000,
          status: "ok",
        },
      ),
    ).rejects.toMatchObject({
      code: "backup_health_write_failed",
      retryable: true,
    })
  })
})

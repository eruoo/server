import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"

import {
  BACKUP_STORAGE_HARD_LIMIT_BYTES,
  BACKUP_STORAGE_SOFT_LIMIT_BYTES,
  DATABASE_BACKUP_LEASE_DURATION_MS,
  DATABASE_BACKUP_MAX_DURATION_MS,
} from "../backup/constants"
import {
  pollD1Export,
  startD1Export,
  type BackupFetch,
  type D1ExportProgress,
} from "../backup/d1-export"
import {
  isDatabaseBackupErrorCode,
  DatabaseBackupError,
  normalizeDatabaseBackupError,
  type DatabaseBackupErrorCode,
} from "../backup/errors"
import {
  completeD1ExportWithinDeadline,
  type DurableD1ExportOperations,
  type ObservedD1ExportProgress,
} from "../backup/export-orchestration"
import {
  recordDatabaseBackupTerminalState,
  type DatabaseBackupTerminalState,
} from "../backup/health"
import {
  acquireMaintenanceLease,
  DATABASE_BACKUP_LEASE_NAME,
} from "../backup/lease"
import { validateBackupSourceRevision } from "../backup/schema"
import {
  createBackupObjectDescriptor,
  listCurrentBackupBytes,
  uploadD1ExportToR2,
} from "../backup/storage"

type DatabaseBackupWorkflowEnvironment = Pick<
  Env,
  | "BACKUPS"
  | "CF_ACCOUNT_ID"
  | "CF_VERSION_METADATA"
  | "D1_DATABASE_ID"
  | "D1_EXPORT_API_TOKEN"
  | "DB"
>

export interface DatabaseBackupWorkflowResult {
  currentStoredBytes: number
  exportBookmark: string
  key: string
  rawBytes: number
  reusedExistingObject: boolean
  sourceRevision: string
}

const WORKFLOW_ERROR_NAME_PREFIX = "DatabaseBackup/"

const DATABASE_STEP_CONFIG = {
  retries: {
    backoff: "linear",
    delay: "1 second",
    limit: 2,
  },
  timeout: "30 seconds",
} as const

/** Cloudflare defines retries.limit as the total number of step attempts. */
export const START_EXPORT_STEP_CONFIG = {
  retries: {
    backoff: "constant",
    delay: "1 second",
    limit: 1,
  },
  sensitive: "output",
  timeout: "30 seconds",
} as const

const POLL_EXPORT_STEP_CONFIG = {
  ...DATABASE_STEP_CONFIG,
  sensitive: "output",
} as const

const UPLOAD_STEP_CONFIG = {
  retries: {
    backoff: "linear",
    delay: "10 seconds",
    limit: 2,
  },
  timeout: "15 minutes",
} as const

function createWorkflowStepError(error: unknown): Error {
  const backupError = normalizeDatabaseBackupError(
    error,
    "backup_configuration_invalid",
    false,
  )

  if (backupError.retryable) {
    return backupError
  }

  return new NonRetryableError(
    backupError.code,
    `${WORKFLOW_ERROR_NAME_PREFIX}${backupError.code}`,
  )
}

function classifyWorkflowFailure(error: unknown): DatabaseBackupError {
  if (error instanceof DatabaseBackupError) {
    return error
  }

  if (
    error instanceof Error &&
    error.name.startsWith(WORKFLOW_ERROR_NAME_PREFIX)
  ) {
    const code = error.name.slice(WORKFLOW_ERROR_NAME_PREFIX.length)
    if (isDatabaseBackupErrorCode(code)) {
      return new DatabaseBackupError(code, {
        cause: error,
        retryable: false,
      })
    }
  }

  if (error instanceof Error && isDatabaseBackupErrorCode(error.message)) {
    return new DatabaseBackupError(error.message, {
      cause: error,
      retryable: false,
    })
  }

  return new DatabaseBackupError("backup_configuration_invalid", {
    cause: error,
    retryable: false,
  })
}

function observeBeforeDeadline(
  deadlineMs: number,
  operation: () => Promise<D1ExportProgress>,
): Promise<ObservedD1ExportProgress> {
  return (async () => {
    const startedAtMs = Date.now()
    if (startedAtMs >= deadlineMs) {
      return {
        observedAtMs: startedAtMs,
        progress: null,
      }
    }

    const progress = await operation()
    const observedAtMs = Date.now()
    return {
      observedAtMs,
      progress: observedAtMs >= deadlineMs ? null : progress,
    }
  })()
}

export async function recordDatabaseBackupExecutionStart(
  step: WorkflowStep,
): Promise<number> {
  const executionStartedAtMs = await step.do(
    "record database backup execution start",
    DATABASE_STEP_CONFIG,
    async () => Date.now(),
  )

  if (
    !Number.isSafeInteger(executionStartedAtMs) ||
    executionStartedAtMs <= 0
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  return executionStartedAtMs
}

interface D1ExportWorkflowEnvironment {
  CF_ACCOUNT_ID: string
  D1_DATABASE_ID: string
  D1_EXPORT_API_TOKEN: string
}

export function createDurableExportOperations(
  step: WorkflowStep,
  environment: D1ExportWorkflowEnvironment,
  fetcher: BackupFetch = fetch,
): DurableD1ExportOperations {
  return {
    async observePoll(pollIndex, bookmark, deadlineMs) {
      return step.do(
        `poll full D1 export ${pollIndex}`,
        POLL_EXPORT_STEP_CONFIG,
        async () => {
          try {
            return await observeBeforeDeadline(deadlineMs, () =>
              pollD1Export(fetcher, {
                accountId: environment.CF_ACCOUNT_ID,
                apiToken: environment.D1_EXPORT_API_TOKEN,
                bookmark,
                databaseId: environment.D1_DATABASE_ID,
              }),
            )
          } catch (error) {
            throw createWorkflowStepError(error)
          }
        },
      )
    },
    async observeStart(deadlineMs) {
      return step.do(
        "start full D1 export",
        START_EXPORT_STEP_CONFIG,
        async () =>
          observeBeforeDeadline(deadlineMs, () =>
            startD1Export(fetcher, {
              accountId: environment.CF_ACCOUNT_ID,
              apiToken: environment.D1_EXPORT_API_TOKEN,
              databaseId: environment.D1_DATABASE_ID,
            }),
          ),
      )
    },
    async sleep(pollIndex, durationMs) {
      await step.sleep(`wait to poll full D1 export ${pollIndex}`, durationMs)
    },
  }
}

function reportBackupFailure(
  error: unknown,
  event: WorkflowEvent<unknown>,
): DatabaseBackupError {
  const backupError = classifyWorkflowFailure(error)
  console.error({
    code: backupError.code,
    event: "database_backup_failed",
    instanceId: event.instanceId,
    retryable: backupError.retryable,
  })
  return backupError
}

export async function recordDatabaseBackupWorkflowTerminalState(
  step: WorkflowStep,
  database: D1Database,
  state: DatabaseBackupTerminalState,
): Promise<void> {
  await step.do(
    `record database backup ${state.status}`,
    DATABASE_STEP_CONFIG,
    async () => {
      try {
        await recordDatabaseBackupTerminalState(database, state)
        return true
      } catch (error) {
        throw createWorkflowStepError(
          normalizeDatabaseBackupError(
            error,
            "backup_health_write_failed",
            true,
          ),
        )
      }
    },
  )
}

const MAXIMUM_DATE_TIMESTAMP_MS = 8_640_000_000_000_000

export async function recordDatabaseBackupWorkflowTerminalTime(
  step: WorkflowStep,
  startedAt: number,
): Promise<number> {
  if (
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0 ||
    startedAt > MAXIMUM_DATE_TIMESTAMP_MS
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  const completedAt = await step.do(
    "record database backup terminal time",
    DATABASE_STEP_CONFIG,
    async () => Math.max(startedAt, Date.now()),
  )

  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt > MAXIMUM_DATE_TIMESTAMP_MS
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  return completedAt
}

export class DatabaseBackupWorkflow extends WorkflowEntrypoint<DatabaseBackupWorkflowEnvironment> {
  override async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<DatabaseBackupWorkflowResult> {
    let executionStartedAtMs: number | undefined

    try {
      const runStartedAtMs = await recordDatabaseBackupExecutionStart(step)
      executionStartedAtMs = runStartedAtMs

      const revision = validateBackupSourceRevision(
        this.env.CF_VERSION_METADATA,
      )
      const leaseExpiresAtMs =
        runStartedAtMs + DATABASE_BACKUP_LEASE_DURATION_MS
      const leaseAcquired = await step.do(
        "acquire database backup lease",
        DATABASE_STEP_CONFIG,
        async () => {
          try {
            return await acquireMaintenanceLease(this.env.DB, {
              expiresAt: leaseExpiresAtMs,
              name: DATABASE_BACKUP_LEASE_NAME,
              now: Date.now(),
              ownerId: event.instanceId,
            })
          } catch (error) {
            throw createWorkflowStepError(error)
          }
        },
      )

      if (!leaseAcquired) {
        throw new DatabaseBackupError("backup_concurrency_conflict", {
          retryable: false,
        })
      }

      await step.do(
        "calculate current R2 backup storage",
        DATABASE_STEP_CONFIG,
        async () => {
          try {
            const storedBytes = await listCurrentBackupBytes(this.env.BACKUPS)
            if (storedBytes >= BACKUP_STORAGE_SOFT_LIMIT_BYTES) {
              console.warn({
                currentStoredBytes: storedBytes,
                event: "database_backup_storage_soft_limit",
                hardLimitBytes: BACKUP_STORAGE_HARD_LIMIT_BYTES,
                instanceId: event.instanceId,
                softLimitBytes: BACKUP_STORAGE_SOFT_LIMIT_BYTES,
              })
            }

            if (storedBytes >= BACKUP_STORAGE_HARD_LIMIT_BYTES) {
              throw new DatabaseBackupError("backup_storage_budget_exceeded", {
                retryable: false,
              })
            }

            return storedBytes
          } catch (error) {
            throw createWorkflowStepError(error)
          }
        },
      )

      const databaseExport = await completeD1ExportWithinDeadline(
        createDurableExportOperations(step, this.env),
        runStartedAtMs,
      )
      const descriptor = createBackupObjectDescriptor({
        createdAt: new Date(runStartedAtMs).toISOString(),
        exportBookmark: databaseExport.bookmark,
        revision,
        workflowInstanceId: event.instanceId,
      })
      const currentStoredBytes = await step.do(
        "recalculate R2 backup storage before upload",
        DATABASE_STEP_CONFIG,
        async () => {
          try {
            const storedBytes = await listCurrentBackupBytes(this.env.BACKUPS)
            if (storedBytes >= BACKUP_STORAGE_HARD_LIMIT_BYTES) {
              throw new DatabaseBackupError("backup_storage_budget_exceeded", {
                retryable: false,
              })
            }

            return storedBytes
          } catch (error) {
            throw createWorkflowStepError(error)
          }
        },
      )
      const upload = await step.do(
        "stream full D1 export directly to R2",
        UPLOAD_STEP_CONFIG,
        async () => {
          try {
            return await uploadD1ExportToR2(this.env.BACKUPS, fetch, {
              currentStoredBytes,
              deadlineMs: runStartedAtMs + DATABASE_BACKUP_MAX_DURATION_MS,
              descriptor,
              signedUrl: databaseExport.signedUrl,
            })
          } catch (error) {
            throw createWorkflowStepError(error)
          }
        },
      )

      if (
        !upload.reusedExistingObject &&
        currentStoredBytes < BACKUP_STORAGE_SOFT_LIMIT_BYTES &&
        currentStoredBytes + upload.rawBytes >= BACKUP_STORAGE_SOFT_LIMIT_BYTES
      ) {
        console.warn({
          currentStoredBytes: currentStoredBytes + upload.rawBytes,
          event: "database_backup_storage_soft_limit",
          hardLimitBytes: BACKUP_STORAGE_HARD_LIMIT_BYTES,
          instanceId: event.instanceId,
          softLimitBytes: BACKUP_STORAGE_SOFT_LIMIT_BYTES,
        })
      }

      const completedAt = await recordDatabaseBackupWorkflowTerminalTime(
        step,
        runStartedAtMs,
      )
      await recordDatabaseBackupWorkflowTerminalState(step, this.env.DB, {
        completedAt,
        runId: event.instanceId,
        startedAt: runStartedAtMs,
        status: "ok",
      })

      return {
        currentStoredBytes,
        exportBookmark: databaseExport.bookmark,
        key: upload.key,
        rawBytes: upload.rawBytes,
        reusedExistingObject: upload.reusedExistingObject,
        sourceRevision: revision.id,
      }
    } catch (error) {
      const backupError = reportBackupFailure(error, event)

      if (
        executionStartedAtMs !== undefined &&
        backupError.code !== "backup_concurrency_conflict"
      ) {
        try {
          const completedAt = await recordDatabaseBackupWorkflowTerminalTime(
            step,
            executionStartedAtMs,
          )
          await recordDatabaseBackupWorkflowTerminalState(step, this.env.DB, {
            completedAt,
            failureCode: backupError.code,
            runId: event.instanceId,
            startedAt: executionStartedAtMs,
            status: "failed",
          })
        } catch (healthError) {
          console.error({
            error:
              healthError instanceof Error ? healthError.name : "unknown_error",
            event: "database_backup_health_write_failed",
            instanceId: event.instanceId,
          })
        }
      }

      throw backupError
    }
  }
}

export type { DatabaseBackupErrorCode }

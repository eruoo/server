import {
  D1_EXPORT_MAX_POLL_DURATION_MS,
  D1_EXPORT_POLL_INTERVAL_MS,
} from "./constants"
import type { D1ExportComplete, D1ExportProgress } from "./d1-export"
import { DatabaseBackupError } from "./errors"

export interface ObservedD1ExportProgress {
  observedAtMs: number
  progress: D1ExportProgress | null
}

export interface DurableD1ExportOperations {
  observePoll: (
    pollIndex: number,
    bookmark: string,
    deadlineMs: number,
  ) => Promise<ObservedD1ExportProgress>
  observeStart: (deadlineMs: number) => Promise<ObservedD1ExportProgress>
  sleep: (pollIndex: number, durationMs: number) => Promise<void>
}

function requireProgress(
  observation: ObservedD1ExportProgress,
  deadlineMs: number,
): D1ExportProgress {
  if (
    !Number.isSafeInteger(observation.observedAtMs) ||
    observation.observedAtMs >= deadlineMs ||
    observation.progress === null
  ) {
    throw new DatabaseBackupError("backup_export_timed_out", {
      retryable: false,
    })
  }

  return observation.progress
}

export async function completeD1ExportWithinDeadline(
  operations: DurableD1ExportOperations,
  startedAtMs: number,
): Promise<D1ExportComplete> {
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  const deadlineMs = startedAtMs + D1_EXPORT_MAX_POLL_DURATION_MS
  let observation = await operations.observeStart(deadlineMs)
  let progress = requireProgress(observation, deadlineMs)
  const bookmark = progress.bookmark
  let pollIndex = 0

  while (progress.state === "pending") {
    if (progress.bookmark !== bookmark) {
      throw new DatabaseBackupError("backup_export_response_invalid", {
        retryable: false,
      })
    }
    if (pollIndex > 90) {
      throw new DatabaseBackupError("backup_export_timed_out", {
        retryable: false,
      })
    }

    const remainingMs = deadlineMs - observation.observedAtMs
    if (remainingMs <= 0) {
      throw new DatabaseBackupError("backup_export_timed_out", {
        retryable: false,
      })
    }

    const durationMs = Math.min(D1_EXPORT_POLL_INTERVAL_MS, remainingMs)
    await operations.sleep(pollIndex, durationMs)

    observation = await operations.observePoll(pollIndex, bookmark, deadlineMs)
    progress = requireProgress(observation, deadlineMs)
    pollIndex += 1
  }

  if (progress.bookmark !== bookmark) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  return progress
}

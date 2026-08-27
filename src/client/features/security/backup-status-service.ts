import { apiClient, type EruooApiClient } from "@client/lib/api-client"
import {
  ApiResponseError,
  hasExactKeys,
  isNonnegativeInteger,
  isRecord,
  readApiJson,
} from "@client/lib/api-response"

import type { paths } from "../../../../.generated/openapi"

type BackupStatusContract =
  paths["/api/security/backup-status"]["get"]["responses"][200]["content"]["application/json"]

export type DatabaseBackupErrorCode = NonNullable<
  BackupStatusContract["errorCode"]
>

export type DatabaseBackupStatus =
  | Readonly<{
      errorCode: null
      lastAttemptAt: null
      lastSuccessAt: null
      status: "never-run"
    }>
  | Readonly<{
      errorCode: null
      lastAttemptAt: number
      lastSuccessAt: number
      status: "ok"
    }>
  | Readonly<{
      errorCode: DatabaseBackupErrorCode
      lastAttemptAt: number
      lastSuccessAt: number | null
      status: "failed"
    }>

const backupStatusKeys = [
  "errorCode",
  "lastAttemptAt",
  "lastSuccessAt",
  "status",
] as const

const maximumDateTimestamp = 8_640_000_000_000_000

const databaseBackupErrorCodes = {
  backup_compression_failed: true,
  backup_concurrency_conflict: true,
  backup_configuration_invalid: true,
  backup_export_authentication_failed: true,
  backup_export_download_failed: true,
  backup_export_download_invalid: true,
  backup_export_failed: true,
  backup_export_request_failed: true,
  backup_export_response_invalid: true,
  backup_export_timed_out: true,
  backup_health_write_failed: true,
  backup_lease_failed: true,
  backup_migration_state_invalid: true,
  backup_object_conflict: true,
  backup_schema_inventory_failed: true,
  backup_schema_inventory_invalid: true,
  backup_storage_budget_exceeded: true,
  backup_storage_inventory_failed: true,
  backup_storage_inventory_invalid: true,
  backup_upload_abort_failed: true,
  backup_upload_failed: true,
  backup_upload_integrity_failed: true,
  backup_upload_timed_out: true,
  backup_virtual_table_detected: true,
} as const satisfies Record<DatabaseBackupErrorCode, true>

export interface BackupStatusService {
  get(): Promise<DatabaseBackupStatus>
}

export { ApiResponseError as BackupStatusApiError }

function isDatabaseBackupErrorCode(
  value: unknown,
): value is DatabaseBackupErrorCode {
  return (
    typeof value === "string" && Object.hasOwn(databaseBackupErrorCodes, value)
  )
}

function isDisplayableEpochMillisecond(value: unknown): value is number {
  return isNonnegativeInteger(value) && value <= maximumDateTimestamp
}

function parseBackupStatus(value: unknown): DatabaseBackupStatus {
  if (!isRecord(value) || !hasExactKeys(value, backupStatusKeys)) {
    throw new ApiResponseError("Database backup status response is invalid.")
  }

  const errorCode = value["errorCode"]
  const lastAttemptAt = value["lastAttemptAt"]
  const lastSuccessAt = value["lastSuccessAt"]
  const status = value["status"]

  if (
    status === "never-run" &&
    errorCode === null &&
    lastAttemptAt === null &&
    lastSuccessAt === null
  ) {
    return { errorCode, lastAttemptAt, lastSuccessAt, status }
  }

  if (
    status === "ok" &&
    errorCode === null &&
    isDisplayableEpochMillisecond(lastAttemptAt) &&
    isDisplayableEpochMillisecond(lastSuccessAt)
  ) {
    return { errorCode, lastAttemptAt, lastSuccessAt, status }
  }

  if (
    status === "failed" &&
    isDatabaseBackupErrorCode(errorCode) &&
    isDisplayableEpochMillisecond(lastAttemptAt) &&
    (lastSuccessAt === null || isDisplayableEpochMillisecond(lastSuccessAt))
  ) {
    return { errorCode, lastAttemptAt, lastSuccessAt, status }
  }

  throw new ApiResponseError("Database backup status state is invalid.")
}

export function createBackupStatusService(
  client: EruooApiClient = apiClient,
): BackupStatusService {
  return {
    async get() {
      return readApiJson(
        () => client.GET("/api/security/backup-status"),
        parseBackupStatus,
      )
    },
  }
}

export const backupStatusService = createBackupStatusService()

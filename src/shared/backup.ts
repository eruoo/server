export const DATABASE_BACKUP_ERROR_CODES = [
  "backup_configuration_invalid",
  "backup_concurrency_conflict",
  "backup_lease_failed",
  "backup_object_conflict",
  "backup_schema_inventory_failed",
  "backup_schema_inventory_invalid",
  "backup_virtual_table_detected",
  "backup_migration_state_invalid",
  "backup_storage_inventory_failed",
  "backup_storage_inventory_invalid",
  "backup_storage_budget_exceeded",
  "backup_export_authentication_failed",
  "backup_export_request_failed",
  "backup_export_response_invalid",
  "backup_export_failed",
  "backup_export_timed_out",
  "backup_export_download_failed",
  "backup_export_download_invalid",
  "backup_compression_failed",
  "backup_upload_timed_out",
  "backup_upload_failed",
  "backup_upload_abort_failed",
  "backup_upload_integrity_failed",
  "backup_health_write_failed",
] as const

export type DatabaseBackupErrorCode =
  (typeof DATABASE_BACKUP_ERROR_CODES)[number]

export type DatabaseBackupStatus =
  | {
      errorCode: null
      lastAttemptAt: null
      lastSuccessAt: null
      status: "never-run"
    }
  | {
      errorCode: null
      lastAttemptAt: number
      lastSuccessAt: number
      status: "ok"
    }
  | {
      errorCode: DatabaseBackupErrorCode
      lastAttemptAt: number
      lastSuccessAt: number | null
      status: "failed"
    }

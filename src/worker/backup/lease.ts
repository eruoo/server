import { DatabaseBackupError, normalizeDatabaseBackupError } from "./errors"

export const DATABASE_BACKUP_LEASE_NAME = "database-backup"

export interface MaintenanceLeaseRequest {
  expiresAt: number
  name: string
  now: number
  ownerId: string
}

function validateLeaseRequest(request: MaintenanceLeaseRequest): void {
  if (
    request.name.length === 0 ||
    request.name.length > 100 ||
    request.ownerId.length === 0 ||
    request.ownerId.length > 128 ||
    !Number.isSafeInteger(request.now) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.now < 0 ||
    request.expiresAt <= request.now
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }
}

export async function acquireMaintenanceLease(
  database: D1Database,
  request: MaintenanceLeaseRequest,
): Promise<boolean> {
  validateLeaseRequest(request)

  try {
    const result = await database
      .prepare(
        `INSERT INTO maintenance_lease (name, ownerId, expiresAt)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET
           ownerId = excluded.ownerId,
           expiresAt = excluded.expiresAt
         WHERE maintenance_lease.expiresAt <= ?4
            OR maintenance_lease.ownerId = excluded.ownerId`,
      )
      .bind(request.name, request.ownerId, request.expiresAt, request.now)
      .run()

    return result.meta.changes === 1
  } catch (error) {
    throw normalizeDatabaseBackupError(error, "backup_lease_failed", true)
  }
}

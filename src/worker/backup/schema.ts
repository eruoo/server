import { DatabaseBackupError } from "./errors"

export interface AppliedMigration {
  appliedAt: string
  id: number
  name: string
}

export interface BackupMigrationState {
  count: number
  digest: string
  latestAppliedAt: string
  latestId: number
  latestName: string
}

export interface BackupSourceRevision {
  id: string
  tag: string
  timestamp: string
}

export interface D1MigrationRow {
  applied_at: unknown
  id: unknown
  name: unknown
}

function parseAppliedMigration(row: D1MigrationRow): AppliedMigration {
  if (
    typeof row.id !== "number" ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    (typeof row.applied_at !== "string" && typeof row.applied_at !== "number")
  ) {
    throw new DatabaseBackupError("backup_migration_state_invalid", {
      retryable: false,
    })
  }

  return {
    appliedAt: String(row.applied_at),
    id: row.id,
    name: row.name,
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

export function normalizeAppliedMigrations(
  rows: readonly D1MigrationRow[],
): AppliedMigration[] {
  const migrations = rows.map(parseAppliedMigration).sort((left, right) => {
    return left.id - right.id
  })

  if (migrations.length === 0) {
    throw new DatabaseBackupError("backup_migration_state_invalid", {
      retryable: false,
    })
  }

  return migrations
}

export async function createMigrationState(
  rows: readonly D1MigrationRow[],
): Promise<BackupMigrationState> {
  const migrations = normalizeAppliedMigrations(rows)
  const latestMigration = migrations.at(-1)
  if (latestMigration === undefined) {
    throw new DatabaseBackupError("backup_migration_state_invalid", {
      retryable: false,
    })
  }

  const encodedState = new TextEncoder().encode(JSON.stringify(migrations))
  const digest = bytesToHex(await crypto.subtle.digest("SHA-256", encodedState))

  return {
    count: migrations.length,
    digest,
    latestAppliedAt: latestMigration.appliedAt,
    latestId: latestMigration.id,
    latestName: latestMigration.name,
  }
}

export function validateBackupSourceRevision(
  revision: WorkerVersionMetadata,
): BackupSourceRevision {
  if (
    revision.id.length === 0 ||
    revision.id.length > 128 ||
    revision.tag.length > 128 ||
    !Number.isFinite(Date.parse(revision.timestamp))
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  return {
    id: revision.id,
    tag: revision.tag,
    timestamp: new Date(revision.timestamp).toISOString(),
  }
}

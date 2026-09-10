import {
  DATABASE_BACKUP_ERROR_CODES,
  type DatabaseBackupErrorCode,
} from "../../shared/backup"
export {
  DATABASE_BACKUP_ERROR_CODES,
  type DatabaseBackupErrorCode,
} from "../../shared/backup"

export function isDatabaseBackupErrorCode(
  value: string,
): value is DatabaseBackupErrorCode {
  return DATABASE_BACKUP_ERROR_CODES.some((code) => code === value)
}

export class DatabaseBackupError extends Error {
  readonly code: DatabaseBackupErrorCode
  readonly retryable: boolean

  constructor(
    code: DatabaseBackupErrorCode,
    options: {
      cause?: unknown
      retryable: boolean
    },
  ) {
    super(
      code,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = "DatabaseBackupError"
    this.code = code
    this.retryable = options.retryable
  }
}

export function normalizeDatabaseBackupError(
  error: unknown,
  fallbackCode: DatabaseBackupErrorCode,
  retryable: boolean,
): DatabaseBackupError {
  if (error instanceof DatabaseBackupError) {
    return error
  }

  return new DatabaseBackupError(fallbackCode, {
    cause: error,
    retryable,
  })
}

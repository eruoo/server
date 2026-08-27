import {
  BACKUP_FORMAT_VERSION,
  BACKUP_OBJECT_PREFIX,
  BACKUP_OBJECT_SUFFIX,
  BACKUP_SINGLE_OBJECT_MAX_BYTES,
  BACKUP_STORAGE_HARD_LIMIT_BYTES,
} from "./constants"
import { downloadD1Export, type BackupFetch } from "./d1-export"
import { DatabaseBackupError, normalizeDatabaseBackupError } from "./errors"
import type { BackupSourceRevision } from "./schema"

export interface BackupObjectDescriptor {
  customMetadata: Record<string, string>
  key: string
}

export interface BackupObjectIdentity {
  createdAt: string
  exportBookmark: string
  revision: BackupSourceRevision
  workflowInstanceId: string
}

export interface BackupUploadResult {
  key: string
  rawBytes: number
  reusedExistingObject: boolean
}

function sanitizeKeySegment(value: string, maximumLength: number): string {
  const sanitizedValue = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumLength)

  if (sanitizedValue.length === 0) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  return sanitizedValue
}

export function createBackupObjectDescriptor(
  identity: BackupObjectIdentity,
): BackupObjectDescriptor {
  const createdAt = new Date(identity.createdAt)
  if (
    !Number.isFinite(createdAt.getTime()) ||
    identity.exportBookmark.length === 0 ||
    identity.exportBookmark.length > 512
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  const normalizedCreatedAt = createdAt.toISOString()
  const datePath = normalizedCreatedAt.slice(0, 10).replaceAll("-", "/")
  const timestamp = normalizedCreatedAt.replaceAll(/[-:.]/g, "")
  const revision = sanitizeKeySegment(identity.revision.id, 128)
  const workflowInstanceId = sanitizeKeySegment(
    identity.workflowInstanceId,
    100,
  )
  const key =
    `${BACKUP_OBJECT_PREFIX}/${datePath}/${timestamp}` +
    `--revision-${revision}` +
    `--workflow-${workflowInstanceId}${BACKUP_OBJECT_SUFFIX}`

  return {
    customMetadata: {
      auditEvents: "included",
      backupContents: "full-database",
      backupFormat: BACKUP_FORMAT_VERSION,
      createdAt: normalizedCreatedAt,
      credentials: "included",
      exportBookmark: identity.exportBookmark,
      sourceRevision: identity.revision.id,
      sourceRevisionTag: identity.revision.tag,
      sourceRevisionTimestamp: identity.revision.timestamp,
      workflowInstanceId,
    },
    key,
  }
}

export async function listCurrentBackupBytes(
  bucket: R2Bucket,
): Promise<number> {
  let currentStoredBytes = 0
  let cursor: string | undefined

  try {
    while (true) {
      const page = await bucket.list(
        cursor === undefined
          ? { limit: 1_000 }
          : {
              cursor,
              limit: 1_000,
            },
      )

      for (const object of page.objects) {
        if (
          !Number.isSafeInteger(object.size) ||
          object.size < 0 ||
          currentStoredBytes > Number.MAX_SAFE_INTEGER - object.size
        ) {
          throw new DatabaseBackupError("backup_storage_inventory_invalid", {
            retryable: false,
          })
        }

        currentStoredBytes += object.size
      }

      if (!page.truncated) {
        break
      }

      if (page.cursor.length === 0 || page.cursor === cursor) {
        throw new DatabaseBackupError("backup_storage_inventory_invalid", {
          retryable: false,
        })
      }
      cursor = page.cursor
    }
  } catch (error) {
    throw normalizeDatabaseBackupError(
      error,
      "backup_storage_inventory_failed",
      true,
    )
  }

  return currentStoredBytes
}

function hasExpectedObjectMetadata(
  object: R2Object,
  descriptor: BackupObjectDescriptor,
): boolean {
  if (
    object.key !== descriptor.key ||
    object.httpMetadata?.contentType !== "application/sql" ||
    object.httpMetadata.contentEncoding !== undefined
  ) {
    return false
  }

  const actualMetadata = object.customMetadata ?? {}
  const expectedEntries = Object.entries({
    ...descriptor.customMetadata,
    contentLength: String(object.size),
  })
  if (Object.keys(actualMetadata).length !== expectedEntries.length) {
    return false
  }

  return expectedEntries.every(([key, value]) => actualMetadata[key] === value)
}

async function reuseCompletedBackupObject(
  bucket: R2Bucket,
  descriptor: BackupObjectDescriptor,
  deadlineMs: number,
): Promise<BackupUploadResult | null> {
  let existingObject: R2Object | null
  try {
    existingObject = await bucket.head(descriptor.key)
  } catch (error) {
    assertUploadBeforeDeadline(deadlineMs)
    throw new DatabaseBackupError("backup_upload_failed", {
      cause: error,
      retryable: true,
    })
  }
  assertUploadBeforeDeadline(deadlineMs)

  if (existingObject === null) {
    return null
  }

  if (
    existingObject.size <= 0 ||
    existingObject.size >= BACKUP_SINGLE_OBJECT_MAX_BYTES ||
    !hasExpectedObjectMetadata(existingObject, descriptor)
  ) {
    throw new DatabaseBackupError("backup_object_conflict", {
      retryable: false,
    })
  }

  return {
    key: descriptor.key,
    rawBytes: existingObject.size,
    reusedExistingObject: true,
  }
}

function assertUploadBeforeDeadline(deadlineMs: number): void {
  if (!Number.isSafeInteger(deadlineMs) || Date.now() >= deadlineMs) {
    throw new DatabaseBackupError("backup_upload_timed_out", {
      retryable: false,
    })
  }
}

async function cancelStreamQuietly(
  stream: ReadableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    if (!stream.locked) await stream.cancel(reason)
  } catch {
    // Preserve the primary classified failure.
  }
}

async function deleteInvalidUploadedObjectQuietly(
  bucket: R2Bucket,
  object: R2Object,
  key: string,
): Promise<void> {
  try {
    await bucket.delete(key)
  } catch (error) {
    console.error({
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "database_backup_invalid_object_cleanup_failed",
      key,
      version: object.version,
    })
  }
}

function validateUploadBudget(
  currentStoredBytes: number,
  contentLength: number,
): void {
  if (
    !Number.isSafeInteger(currentStoredBytes) ||
    currentStoredBytes < 0 ||
    currentStoredBytes >= BACKUP_STORAGE_HARD_LIMIT_BYTES ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength >= BACKUP_SINGLE_OBJECT_MAX_BYTES ||
    currentStoredBytes > BACKUP_STORAGE_HARD_LIMIT_BYTES - contentLength ||
    currentStoredBytes + contentLength >= BACKUP_STORAGE_HARD_LIMIT_BYTES
  ) {
    throw new DatabaseBackupError("backup_storage_budget_exceeded", {
      retryable: false,
    })
  }
}

export async function uploadD1ExportToR2(
  bucket: R2Bucket,
  fetcher: BackupFetch,
  request: {
    currentStoredBytes: number
    deadlineMs: number
    descriptor: BackupObjectDescriptor
    signedUrl: string
  },
): Promise<BackupUploadResult> {
  assertUploadBeforeDeadline(request.deadlineMs)

  const reusedObject = await reuseCompletedBackupObject(
    bucket,
    request.descriptor,
    request.deadlineMs,
  )
  if (reusedObject !== null) {
    return reusedObject
  }

  const download = await downloadD1Export(
    fetcher,
    request.signedUrl,
    Math.max(1, request.deadlineMs - Date.now()),
  )

  try {
    assertUploadBeforeDeadline(request.deadlineMs)
    validateUploadBudget(request.currentStoredBytes, download.contentLength)
  } catch (error) {
    await cancelStreamQuietly(download.body, error)
    throw error
  }

  let storedObject: R2Object | null
  try {
    storedObject = await bucket.put(request.descriptor.key, download.body, {
      customMetadata: {
        ...request.descriptor.customMetadata,
        contentLength: String(download.contentLength),
      },
      httpMetadata: {
        contentType: "application/sql",
      },
      onlyIf: {
        etagDoesNotMatch: "*",
      },
      storageClass: "Standard",
    })
  } catch (error) {
    await cancelStreamQuietly(download.body, error)
    assertUploadBeforeDeadline(request.deadlineMs)
    throw normalizeDatabaseBackupError(error, "backup_upload_failed", true)
  }

  if (storedObject === null) {
    const racedObject = await reuseCompletedBackupObject(
      bucket,
      request.descriptor,
      request.deadlineMs,
    )
    if (racedObject !== null) return racedObject

    throw new DatabaseBackupError("backup_upload_failed", {
      retryable: true,
    })
  }

  if (
    storedObject.size !== download.contentLength ||
    !hasExpectedObjectMetadata(storedObject, request.descriptor)
  ) {
    await deleteInvalidUploadedObjectQuietly(
      bucket,
      storedObject,
      request.descriptor.key,
    )
    throw new DatabaseBackupError("backup_upload_integrity_failed", {
      retryable: false,
    })
  }

  assertUploadBeforeDeadline(request.deadlineMs)

  return {
    key: request.descriptor.key,
    rawBytes: storedObject.size,
    reusedExistingObject: false,
  }
}

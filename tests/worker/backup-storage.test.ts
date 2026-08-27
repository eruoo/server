import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BACKUP_STORAGE_HARD_LIMIT_BYTES } from "../../src/worker/backup/constants"
import type { BackupFetch } from "../../src/worker/backup/d1-export"
import {
  createBackupObjectDescriptor,
  listCurrentBackupBytes,
  uploadD1ExportToR2,
} from "../../src/worker/backup/storage"

const createdKeys = new Set<string>()
const sql = "CREATE TABLE user(id TEXT);"

function descriptor(workflowInstanceId = crypto.randomUUID()) {
  return createBackupObjectDescriptor({
    createdAt: "2026-08-23T03:00:00.000Z",
    exportBookmark: "bookmark-1",
    revision: {
      id: "00000000-0000-4000-8000-000000000001",
      tag: "production",
      timestamp: "2026-08-23T02:59:00.000Z",
    },
    workflowInstanceId,
  })
}

function sqlFetcher(
  contentLength = String(new TextEncoder().encode(sql).length),
) {
  return vi.fn<BackupFetch>(
    async () =>
      new Response(sql, { headers: { "Content-Length": contentLength } }),
  )
}

function bucketWithOverrides(
  overrides: Partial<Pick<R2Bucket, "delete" | "head" | "put">>,
): R2Bucket {
  return new Proxy(env.BACKUPS, {
    get(target, property) {
      const override = overrides[property as keyof typeof overrides]
      if (override !== undefined) return override

      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

afterEach(async () => {
  vi.useRealTimers()
  if (createdKeys.size > 0) {
    await env.BACKUPS.delete([...createdKeys])
    createdKeys.clear()
  }
})

describe("R2 database backup storage", () => {
  it("builds a bookmark- and revision-addressed v2 descriptor", () => {
    const object = descriptor("workflow-instance")

    expect(object.key).toBe(
      "d1/2026/08/23/20260823T030000000Z--revision-00000000-0000-4000-8000-000000000001--workflow-workflow-instance.sql",
    )
    expect(object.customMetadata).toEqual({
      auditEvents: "included",
      backupContents: "full-database",
      backupFormat: "2",
      createdAt: "2026-08-23T03:00:00.000Z",
      credentials: "included",
      exportBookmark: "bookmark-1",
      sourceRevision: "00000000-0000-4000-8000-000000000001",
      sourceRevisionTag: "production",
      sourceRevisionTimestamp: "2026-08-23T02:59:00.000Z",
      workflowInstanceId: "workflow-instance",
    })
  })

  it("counts every object in the dedicated bucket for the 9 GB guard", async () => {
    const baseline = await listCurrentBackupBytes(env.BACKUPS)
    const prefix = `test-${crypto.randomUUID()}`
    const snapshotKey = `${prefix}.sql`
    const ignoredKey = `${prefix}.txt`
    createdKeys.add(snapshotKey)
    createdKeys.add(ignoredKey)
    await env.BACKUPS.put(snapshotKey, "12345")
    await env.BACKUPS.put(ignoredKey, "123456789")

    await expect(listCurrentBackupBytes(env.BACKUPS)).resolves.toBe(
      baseline + 14,
    )
  })

  it("streams one complete export directly into R2", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    const result = await uploadD1ExportToR2(env.BACKUPS, sqlFetcher(), {
      currentStoredBytes: 0,
      deadlineMs: Date.now() + 60_000,
      descriptor: object,
      signedUrl: "https://signed.example/database.sql",
    })

    expect(result).toEqual({
      key: object.key,
      rawBytes: new TextEncoder().encode(sql).length,
      reusedExistingObject: false,
    })
    const stored = await env.BACKUPS.get(object.key)
    expect(stored?.httpMetadata).toEqual({ contentType: "application/sql" })
    expect(stored?.customMetadata).toEqual({
      ...object.customMetadata,
      contentLength: String(new TextEncoder().encode(sql).length),
    })
    await expect(stored?.text()).resolves.toBe(sql)
  })

  it("reuses an exact completed object without redownloading", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    const first = await uploadD1ExportToR2(env.BACKUPS, sqlFetcher(), {
      currentStoredBytes: 0,
      deadlineMs: Date.now() + 60_000,
      descriptor: object,
      signedUrl: "https://signed.example/database.sql",
    })
    const retryFetcher = vi.fn<BackupFetch>(async () => {
      throw new Error("completed retries must not redownload")
    })
    const second = await uploadD1ExportToR2(env.BACKUPS, retryFetcher, {
      currentStoredBytes: 0,
      deadlineMs: Date.now() + 60_000,
      descriptor: object,
      signedUrl: "https://signed.example/database.sql",
    })

    expect(second).toEqual({ ...first, reusedExistingObject: true })
    expect(retryFetcher).not.toHaveBeenCalled()
  })

  it("fails closed when an existing-object HEAD completes at the upload deadline", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    const rawBytes = new TextEncoder().encode(sql).length
    await env.BACKUPS.put(object.key, sql, {
      customMetadata: {
        ...object.customMetadata,
        contentLength: String(rawBytes),
      },
      httpMetadata: { contentType: "application/sql" },
    })

    vi.useFakeTimers()
    const startedAt = new Date("2033-05-18T03:20:00.000Z")
    const deadlineMs = startedAt.getTime() + 1_000
    vi.setSystemTime(startedAt)
    const fetcher = sqlFetcher()
    const headObject = vi.fn<R2Bucket["head"]>(async (key) => {
      const existingObject = await env.BACKUPS.head(key)
      vi.setSystemTime(deadlineMs)
      return existingObject
    })

    await expect(
      uploadD1ExportToR2(bucketWithOverrides({ head: headObject }), fetcher, {
        currentStoredBytes: 0,
        deadlineMs,
        descriptor: object,
        signedUrl: "https://signed.example/database.sql",
      }),
    ).rejects.toThrow("backup_upload_timed_out")

    expect(fetcher).not.toHaveBeenCalled()
    await expect(
      env.BACKUPS.get(object.key)?.then((body) => body?.text()),
    ).resolves.toBe(sql)
  })

  it("keeps a valid object when PUT completes at the upload deadline", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    vi.useFakeTimers()
    const startedAt = new Date("2033-05-18T03:20:00.000Z")
    const deadlineMs = startedAt.getTime() + 1_000
    vi.setSystemTime(startedAt)
    const deleteObject = vi.fn<R2Bucket["delete"]>(async () => {})
    const putObject = vi.fn<R2Bucket["put"]>(async (key, value, options) => {
      const storedObject = await env.BACKUPS.put(key, value, options)
      vi.setSystemTime(deadlineMs)
      return storedObject
    })

    await expect(
      uploadD1ExportToR2(
        bucketWithOverrides({ delete: deleteObject, put: putObject }),
        sqlFetcher(),
        {
          currentStoredBytes: 0,
          deadlineMs,
          descriptor: object,
          signedUrl: "https://signed.example/database.sql",
        },
      ),
    ).rejects.toThrow("backup_upload_timed_out")

    expect(deleteObject).not.toHaveBeenCalled()
    const storedObject = await env.BACKUPS.get(object.key)
    expect(storedObject?.customMetadata).toEqual({
      ...object.customMetadata,
      contentLength: String(new TextEncoder().encode(sql).length),
    })
    await expect(storedObject?.text()).resolves.toBe(sql)
  })

  it("never overwrites an object-key conflict", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    await env.BACKUPS.put(object.key, "unrelated")
    const fetcher = sqlFetcher()
    const deleteObject = vi.fn<R2Bucket["delete"]>(async () => {})

    await expect(
      uploadD1ExportToR2(
        bucketWithOverrides({ delete: deleteObject }),
        fetcher,
        {
          currentStoredBytes: 0,
          deadlineMs: Date.now() + 60_000,
          descriptor: object,
          signedUrl: "https://signed.example/database.sql",
        },
      ),
    ).rejects.toThrow("backup_object_conflict")
    expect(fetcher).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it("rejects the 9 GB aggregate boundary before creating an object", async () => {
    const object = descriptor()
    createdKeys.add(object.key)

    await expect(
      uploadD1ExportToR2(env.BACKUPS, sqlFetcher(), {
        currentStoredBytes: BACKUP_STORAGE_HARD_LIMIT_BYTES - sql.length,
        deadlineMs: Date.now() + 60_000,
        descriptor: object,
        signedUrl: "https://signed.example/database.sql",
      }),
    ).rejects.toThrow("backup_storage_budget_exceeded")
    await expect(env.BACKUPS.head(object.key)).resolves.toBeNull()
  })

  it("deletes a newly created object when post-put integrity validation fails", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    await expect(
      uploadD1ExportToR2(env.BACKUPS, sqlFetcher("1"), {
        currentStoredBytes: 0,
        deadlineMs: Date.now() + 60_000,
        descriptor: object,
        signedUrl: "https://signed.example/database.sql",
      }),
    ).rejects.toThrow("backup_upload_integrity_failed")

    await expect(env.BACKUPS.head(object.key)).resolves.toBeNull()
  })

  it("preserves the integrity failure and logs when invalid-object cleanup fails", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    const deleteObject = vi
      .fn<R2Bucket["delete"]>()
      .mockRejectedValue(new Error("synthetic cleanup failure"))
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await expect(
        uploadD1ExportToR2(
          bucketWithOverrides({ delete: deleteObject }),
          sqlFetcher("1"),
          {
            currentStoredBytes: 0,
            deadlineMs: Date.now() + 60_000,
            descriptor: object,
            signedUrl: "https://signed.example/database.sql",
          },
        ),
      ).rejects.toThrow("backup_upload_integrity_failed")

      expect(deleteObject).toHaveBeenCalledWith(object.key)
      expect(errorLog).toHaveBeenCalledWith({
        errorName: "Error",
        event: "database_backup_invalid_object_cleanup_failed",
        key: object.key,
        version: expect.any(String),
      })
      await expect(env.BACKUPS.head(object.key)).resolves.not.toBeNull()
    } finally {
      errorLog.mockRestore()
    }
  })

  it("does not delete an object that wins the conditional-put race", async () => {
    const object = descriptor()
    createdKeys.add(object.key)
    const deleteObject = vi.fn<R2Bucket["delete"]>(async () => {})
    const putObject = vi.fn<R2Bucket["put"]>(async (key, value, options) => {
      await env.BACKUPS.put(key, "raced-object")
      return env.BACKUPS.put(key, value, options)
    })

    await expect(
      uploadD1ExportToR2(
        bucketWithOverrides({ delete: deleteObject, put: putObject }),
        sqlFetcher(),
        {
          currentStoredBytes: 0,
          deadlineMs: Date.now() + 60_000,
          descriptor: object,
          signedUrl: "https://signed.example/database.sql",
        },
      ),
    ).rejects.toThrow("backup_object_conflict")
    expect(deleteObject).not.toHaveBeenCalled()
    await expect(
      env.BACKUPS.get(object.key)?.then((body) => body?.text()),
    ).resolves.toBe("raced-object")
  })
})

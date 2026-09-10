import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  DATABASE_BACKUP_LEASE_COMMIT_GUARD_MS,
  DATABASE_BACKUP_LEASE_DURATION_MS,
  DATABASE_BACKUP_MAX_DURATION_MS,
  DATABASE_BACKUP_UPLOAD_STEP_TIMEOUT_MS,
} from "../../src/worker/backup/constants"
import { acquireMaintenanceLease } from "../../src/worker/backup/lease"

const now = 2_000_000_000_000

function acquire(
  ownerId: string,
  overrides: { expiresAt?: number; now?: number } = {},
) {
  return acquireMaintenanceLease(env.DB, {
    expiresAt: overrides.expiresAt ?? now + 60_000,
    name: "database-backup",
    now: overrides.now ?? now,
    ownerId,
  })
}

describe("D1 maintenance lease", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM maintenance_lease").run()
  })

  it("allows one owner to acquire and renew while rejecting a competitor", async () => {
    await expect(acquire("workflow-a")).resolves.toBe(true)
    await expect(acquire("workflow-b")).resolves.toBe(false)
    await expect(
      acquire("workflow-a", { expiresAt: now + 120_000, now: now + 1 }),
    ).resolves.toBe(true)

    const lease = await env.DB.prepare(
      `SELECT ownerId, expiresAt
       FROM maintenance_lease
       WHERE name = 'database-backup'`,
    ).first<{ expiresAt: number; ownerId: string }>()

    expect(lease).toEqual({
      expiresAt: now + 120_000,
      ownerId: "workflow-a",
    })
  })

  it("allows a different owner to take over an expired lease", async () => {
    await expect(acquire("workflow-a")).resolves.toBe(true)
    await expect(
      acquire("workflow-b", { expiresAt: now + 180_000, now: now + 60_000 }),
    ).resolves.toBe(true)
  })

  it("atomically chooses one winner from concurrent contenders", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) => acquire(`workflow-${index}`)),
    )

    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })

  it("rejects a lease that is already expired", async () => {
    await expect(
      acquire("workflow-a", { expiresAt: now, now }),
    ).rejects.toThrow("backup_configuration_invalid")
  })

  it("fences a timed-out R2 upload beyond the workflow deadline", () => {
    expect(DATABASE_BACKUP_LEASE_COMMIT_GUARD_MS).toBeGreaterThan(
      DATABASE_BACKUP_UPLOAD_STEP_TIMEOUT_MS,
    )
    expect(DATABASE_BACKUP_LEASE_DURATION_MS).toBe(
      DATABASE_BACKUP_MAX_DURATION_MS + DATABASE_BACKUP_LEASE_COMMIT_GUARD_MS,
    )
  })
})

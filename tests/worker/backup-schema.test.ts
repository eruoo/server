import { describe, expect, it } from "vitest"

import {
  createMigrationState,
  normalizeAppliedMigrations,
  validateBackupSourceRevision,
} from "../../src/worker/backup/schema"

describe("D1 backup metadata", () => {
  it("creates a stable migration digest and records the latest migration", async () => {
    const first = await createMigrationState([
      { applied_at: "2026-01-01T00:00:00Z", id: 1, name: "one.sql" },
      { applied_at: "2026-01-02T00:00:00Z", id: 2, name: "two.sql" },
    ])
    const second = await createMigrationState([
      { applied_at: "2026-01-02T00:00:00Z", id: 2, name: "two.sql" },
      { applied_at: "2026-01-01T00:00:00Z", id: 1, name: "one.sql" },
    ])

    expect(first).toEqual(second)
    expect(first).toMatchObject({
      count: 2,
      latestId: 2,
      latestName: "two.sql",
    })
    expect(first.digest).toMatch(/^[a-f\d]{64}$/)
  })

  it("rejects an empty or malformed migration ledger", () => {
    expect(() => normalizeAppliedMigrations([])).toThrow(
      "backup_migration_state_invalid",
    )
    expect(() =>
      normalizeAppliedMigrations([{ applied_at: 0, id: 0, name: "bad.sql" }]),
    ).toThrow("backup_migration_state_invalid")
  })

  it("normalizes the Cloudflare version identity", () => {
    expect(
      validateBackupSourceRevision({
        id: "revision-1",
        tag: "production",
        timestamp: "2026-08-23T00:00:00Z",
      }),
    ).toEqual({
      id: "revision-1",
      tag: "production",
      timestamp: "2026-08-23T00:00:00.000Z",
    })
  })
})

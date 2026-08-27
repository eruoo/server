import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, describe, expect, it } from "vitest"

import { createBackupObjectDescriptor } from "../src/worker/backup/storage"
import {
  createCredentialScrubSql,
  createRestoreCompletedAuditSql,
  inspectBackupSql,
  validateBackupDescriptor,
  validateRestoreTarget,
} from "./lib/restore-database"

const temporaryDirectories: string[] = []
const foundationSql = await readFile(
  path.resolve("migrations/0001_foundation.sql"),
  "utf8",
)
const repositoryMigrations = [
  { name: "0001_foundation.sql", sql: foundationSql },
] as const

function descriptor() {
  const object = createBackupObjectDescriptor({
    createdAt: "2026-08-23T19:00:00.000Z",
    exportBookmark: "bookmark-1",
    revision: {
      id: "11111111-1111-4111-8111-111111111111",
      tag: "production",
      timestamp: "2026-08-23T18:55:00.000Z",
    },
    workflowInstanceId: "backup-instance-1",
  })
  return {
    ...object,
    customMetadata: { ...object.customMetadata, contentLength: "1234" },
    etag: "a".repeat(32),
    size: 1234,
    httpMetadata: { contentType: "application/sql" },
    storageClass: "Standard",
  }
}

async function createDump(extraSql = "", migrationSql?: string) {
  return `
    PRAGMA defer_foreign_keys=TRUE;
    BEGIN TRANSACTION;
    CREATE TABLE "d1_migrations" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "name" TEXT UNIQUE,
      "applied_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    DELETE FROM "sqlite_sequence";
    ${foundationSql}
    ${
      migrationSql ??
      'INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, \'0001_foundation.sql\', \'2026-08-23 00:00:00\');'
    }
    ${extraSql}
    COMMIT;
  `
}

async function writeSql(sql: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eruoo-restore-test-"))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, "snapshot.sql")
  await writeFile(filePath, sql)
  return filePath
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("database restore planning", () => {
  it("validates exact v2 backup identity and an isolated target", () => {
    expect(validateBackupDescriptor(descriptor())).toMatchObject({
      exportBookmark: "bookmark-1",
      revision: { tag: "production" },
    })
    expect(
      validateRestoreTarget({
        databaseId: "22222222-2222-4222-8222-222222222222",
        databaseName: "eruoo-server-restore-20260823",
        productionDatabaseId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({ databaseName: "eruoo-server-restore-20260823" })
  })

  it("rejects metadata drift and the production database as a target", () => {
    const input = descriptor()
    const metadata: Record<string, string> = input.customMetadata
    metadata["unexpected"] = "value"

    expect(() => validateBackupDescriptor(input)).toThrow("unexpected shape")
    expect(() =>
      validateRestoreTarget({
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "eruoo-server-restore-20260823",
        productionDatabaseId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("distinct from production")
  })

  it("requires descriptor size and the signed Content-Length metadata to agree", () => {
    const input = descriptor()
    input.customMetadata.contentLength = "1235"
    expect(() => validateBackupDescriptor(input)).toThrow(
      "identity do not match",
    )
  })

  it("executes a complete raw SQL snapshot and derives its real migration state", async () => {
    const snapshot = await writeSql(await createDump())

    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).resolves.toMatchObject({
      migration: {
        count: 1,
        latestId: 1,
        latestName: "0001_foundation.sql",
      },
      sha256: expect.stringMatching(/^[a-f\d]{64}$/),
    })
  })

  it("executes INSERT OR REPLACE audit data before proving scrub removes it", async () => {
    const snapshot = await writeSql(
      await createDump(`
        INSERT OR REPLACE INTO "security_audit_events" VALUES
          ('event', 'github_login', 'success', 0, NULL, NULL, NULL, NULL, 'request', NULL);
      `),
    )

    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).resolves.toMatchObject({
      migration: { count: 1 },
    })
  })

  it.each([
    "ATTACH DATABASE '/tmp/eruoo-escape.sqlite' AS escape;",
    "DETACH DATABASE main;",
    "PRAGMA writable_schema=ON;",
    "CREATE VIRTUAL TABLE search USING fts5(value);",
    "CREATE VIEW leaked AS SELECT * FROM account;",
    "CREATE TRIGGER leaked AFTER INSERT ON account BEGIN DELETE FROM account; END;",
  ])("rejects unauthorized SQLite operation: %s", async (operation) => {
    const snapshot = await writeSql(await createDump(operation))
    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("does not accept a migration ledger hidden in comments", async () => {
    const snapshot = await writeSql(
      await createDump(
        "-- INSERT INTO d1_migrations VALUES (1, '0001_foundation.sql', 0);",
        "",
      ),
    )
    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("rejects an INSERT OR REPLACE migration ledger that is not the manifest prefix", async () => {
    const snapshot = await writeSql(
      await createDump(
        "",
        "INSERT OR REPLACE INTO d1_migrations VALUES (1, '0001_not-foundation.sql', 0);",
      ),
    )
    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("rejects an unknown ordinary table despite a valid migration ledger", async () => {
    const snapshot = await writeSql(
      await createDump('CREATE TABLE "unexpected_data" ("value" TEXT);'),
    )
    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("rejects an extra constant UNIQUE index attached to d1_migrations", async () => {
    const snapshot = await writeSql(
      await createDump(
        'CREATE UNIQUE INDEX "poison" ON "d1_migrations" (("id" % 1));',
      ),
    )

    await expect(
      inspectBackupSql(snapshot, repositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("generates a transaction-free scrub separately from completion audit", () => {
    const scrub = createCredentialScrubSql()
    expect(scrub).toContain('DELETE FROM "session"')
    expect(scrub).toContain('DELETE FROM "jwks"')
    expect(scrub).toContain('DELETE FROM "oauthRefreshTokenFamilyRevocation"')
    expect(scrub).toContain('DELETE FROM "maintenance_lease"')
    expect(scrub).toContain('DELETE FROM "database_backup_health"')
    expect(scrub).toContain('DELETE FROM "security_audit_events"')
    expect(scrub).toContain("eruoo-desktop")
    expect(scrub).not.toMatch(/\b(?:BEGIN|COMMIT)\b/)
    expect(scrub).not.toContain("database_restore_completed")

    expect(
      createRestoreCompletedAuditSql({
        occurredAt: 1_787_500_000_000,
        requestId: "33333333-3333-4333-8333-333333333333",
        restoreId: "44444444-4444-4444-8444-444444444444",
        sourceRevision: "11111111-1111-4111-8111-111111111111",
      }),
    ).toContain("database_restore_completed")
  })

  it("keeps the scrub executable against the real foundation schema", async () => {
    const database = new DatabaseSync(":memory:")

    try {
      database.exec(
        await readFile(path.resolve("migrations/0001_foundation.sql"), "utf8"),
      )
      database.exec(`
        INSERT INTO "user" VALUES ('owner', 'Owner', 'owner@example.invalid', 1, NULL, 0, 0);
        INSERT INTO "account" ("id", "issuer", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "scope", "password", "createdAt", "updatedAt") VALUES ('account', 'github', '50254496', 'github', 'owner', 'access', 'refresh', 'id', 'scope', 'password', 0, 0);
        INSERT INTO "session" VALUES ('session', 999999, 'session-token', 0, 0, NULL, NULL, 'owner', 0);
        INSERT OR REPLACE INTO "security_audit_events" VALUES ('event', 'github_login', 'success', 0, 'owner', NULL, NULL, NULL, 'request', NULL);
      `)

      database.exec(`BEGIN IMMEDIATE;\n${createCredentialScrubSql()}\nCOMMIT;`)
      expect(
        database.prepare('SELECT * FROM "security_audit_events"').all(),
      ).toEqual([])
      expect(
        database.prepare('SELECT * FROM "database_backup_health"').all(),
      ).toEqual([])
      expect(
        database
          .prepare(
            'SELECT "accessToken", "refreshToken", "idToken", "scope", "password" FROM "account"',
          )
          .get(),
      ).toEqual({
        accessToken: null,
        idToken: null,
        password: null,
        refreshToken: null,
        scope: null,
      })
    } finally {
      database.close()
    }
  })
})

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

import { createBackupObjectDescriptor } from "../src/worker/backup/storage"
import { migrationReceiptTableSql } from "./lib/migration-receipt"
import {
  createCredentialScrubSql,
  createRestoreCompletedAuditSql,
  inspectBackupSql,
  validateBackupDescriptor,
  validateRestoreTarget,
} from "./lib/restore-database"

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const foundationSql = await readFile(
  path.resolve("migrations/0001_foundation.sql"),
  "utf8",
)
const aiServiceSql = await readFile(
  path.resolve("migrations/0002_ai_service.sql"),
  "utf8",
)
const invocationAdmissionSql = await readFile(
  path.resolve("migrations/0003_invocation_admission.sql"),
  "utf8",
)
const repositoryMigrations = [
  { name: "0001_foundation.sql", sql: foundationSql },
] as const
const fullRepositoryMigrations = [
  { name: "0001_foundation.sql", sql: foundationSql },
  { name: "0002_ai_service.sql", sql: aiServiceSql },
  { name: "0003_invocation_admission.sql", sql: invocationAdmissionSql },
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

async function createDump(
  extraSql = "",
  migrationSql?: string,
  additionalSchemaSql = "",
) {
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
    ${additionalSchemaSql}
    ${
      migrationSql ??
      'INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, \'0001_foundation.sql\', \'2026-08-23 00:00:00\');'
    }
    ${extraSql}
    COMMIT;
  `
}

const aiLedgerSql = `INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (1, '0001_foundation.sql', '2026-09-17 00:00:00');
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (2, '0002_ai_service.sql', '2026-09-18 00:00:00');`
const aiAdmissionLedgerSql = `${aiLedgerSql}
INSERT INTO "d1_migrations" ("id", "name", "applied_at") VALUES (3, '0003_invocation_admission.sql', '2026-09-19 00:00:00');`

const connectedConnectionId = "33333333-3333-4333-8333-333333333330"
const freshConnectionId = "33333333-3333-4333-8333-333333333331"
const pendingSessionId = "44444444-4444-4444-8444-444444444440"
const completedSessionId = "44444444-4444-4444-8444-444444444441"

// One INSERT per row, matching the real D1 export statement shape.
const aiConnectionSeedSql = `INSERT INTO "ai_connections" VALUES ('${connectedConnectionId}', 'codex-main', 'Codex main', 'openai-codex', 1, 'connected', 'account-50254496', 3, 'opaque-credential-package', 1800000100000, '55555555-5555-4555-8555-555555555550', 1800000050000, 1800000000000, 1800000000000);
INSERT INTO "ai_connections" VALUES ('${freshConnectionId}', 'codex-archive', 'Codex archive', 'openai-codex', 0, 'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, 1800000000000, 1800000000000);`

const aiSessionSeedSql = `INSERT INTO "ai_authorization_sessions" VALUES ('${pendingSessionId}', '${connectedConnectionId}', 'owner', 'owner-session', 3, 'pending', 'opaque-device-grant', 1800018000000, 1800000100000, '66666666-6666-4666-8666-666666666660', 1800000400000, NULL, 1800000000000, 1800000000000);
INSERT INTO "ai_authorization_sessions" VALUES ('${completedSessionId}', '${connectedConnectionId}', 'owner', 'owner-session', 2, 'completed', 'opaque-device-grant', 1800018000000, 1800000100000, '66666666-6666-4666-8666-666666666661', 1800000400000, '77777777-7777-4777-8777-777777777770', 1799990000000, 1799995000000);`

const aiModelSeedSql = `INSERT INTO "ai_models" VALUES ('${connectedConnectionId}', 'gpt-6-astra', 'GPT-6 Astra', '{"text":true}', 3, 1800000000000);
INSERT INTO "ai_models" VALUES ('${connectedConnectionId}', 'GPT-6-Astra', 'GPT-6 Astra exact id', '{"text":true}', 3, 1800000000000);`

const aiInvocationSeedSql = `INSERT INTO "ai_invocations" VALUES ('88888888-8888-4888-8888-888888888880', 'key-1', '${connectedConnectionId}', 'gpt-6-astra', 1799990000000, 1799993000000, 1799993030000, 'reserved', NULL, NULL, NULL, NULL);
INSERT INTO "ai_invocations" VALUES ('88888888-8888-4888-8888-888888888881', 'key-2', '${connectedConnectionId}', 'gpt-6-astra', 1799980000000, 1799983000000, 1799983030000, 'succeeded', 1799983000000, NULL, 'req_upstream_1', '{"input_tokens":12,"output_tokens":34}');`

/**
 * Realistic AI-era rows: a connected connection with credentials and a
 * refresh claim, a fresh never-authorized connection, pending and completed
 * authorization sessions, model snapshots, and both an in-flight and a
 * terminal invocation.
 */
const aiSeedSql = [
  aiConnectionSeedSql,
  aiSessionSeedSql,
  aiModelSeedSql,
  aiInvocationSeedSql,
].join("\n")

/**
 * An admission-era reservation that was admitted before the model was
 * resolved: it carries no identity at all, which only the nullable columns of
 * the admission migration can represent.
 */
const aiUnidentifiedInvocationSeedSql = `INSERT INTO "ai_invocations" VALUES ('88888888-8888-4888-8888-888888888882', 'key-3', NULL, NULL, 1799991000000, 1799994000000, 1799994030000, 'reserved', NULL, NULL, NULL, NULL);`

const aiAdmissionSeedSql = `${aiSeedSql}\n${aiUnidentifiedInvocationSeedSql}`

/**
 * The AI schema exactly as the three migrations leave it, in the statement
 * shape a snapshot carries. The admission migration rebuilds the table in
 * place, so the resulting schema cannot be sliced out of the migration text.
 */
function admissionEraAiSchemaSql(): string {
  const database = new DatabaseSync(":memory:")
  try {
    database.exec(foundationSql)
    database.exec(aiServiceSql)
    database.exec(invocationAdmissionSql)
    const rows = database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name LIKE 'ai!_%' ESCAPE '!' ORDER BY type DESC, name",
      )
      .all() as { sql: string }[]
    return rows.map((row) => `${row.sql};`).join("\n")
  } finally {
    database.close()
  }
}

async function writeSql(sql: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eruoo-restore-test-"))
  temporaryDirectories.push(directory)
  const filePath = path.join(directory, "snapshot.sql")
  await writeFile(filePath, sql)
  return filePath
}

it("validates deployment receipt schema and removes its source binding during restore", async () => {
  const sql = await createDump(
    migrationReceiptTableSql +
      `INSERT INTO deployment_migrations VALUES (1,'source-db','{}');`,
  )
  const snapshot = await writeSql(sql)
  const inspection = await inspectBackupSql(snapshot, repositoryMigrations)
  expect(inspection.hasDeploymentReceipt).toBe(true)
  expect(inspection.hasAiApplicationTables).toBe(false)
  expect(createCredentialScrubSql({ hasDeploymentReceipt: true })).toContain(
    'DELETE FROM "deployment_migrations";',
  )
})

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

  it("restores native D1 exports containing CR, LF, quotes, and Unicode", async () => {
    const exportedRows = await readFile(
      new URL("./fixtures/d1-export-text.sql", import.meta.url),
      "utf8",
    )
    const sql = await createDump(exportedRows)
    const database = new DatabaseSync(":memory:")
    try {
      database.exec(sql)
      expect(
        database.prepare("SELECT id,name FROM apikey ORDER BY id").all(),
      ).toEqual([
        { id: "cr", name: "a\rb" },
        { id: "lf", name: "a\nb" },
        { id: "mixed", name: "设备's\r\nkey" },
        { id: "plain", name: "a b" },
      ])
    } finally {
      database.close()
    }
    await expect(
      inspectBackupSql(await writeSql(sql), repositoryMigrations),
    ).resolves.toMatchObject({ migration: { count: 1 } })
  })

  it.each(["upper('owner')", "replace('a','a',hex(randomblob(8)))"])(
    "still rejects functions outside the export allowlist: %s",
    async (expression) => {
      const snapshot = await writeSql(
        await createDump(
          `INSERT INTO "user" VALUES ('owner',${expression},'owner@example.invalid',1,NULL,0,0);`,
        ),
      )
      await expect(
        inspectBackupSql(snapshot, repositoryMigrations),
      ).rejects.toThrow("isolated semantic restore validation")
    },
  )

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
    expect(scrub).not.toContain("ai_")

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

describe("AI-era restore planning", () => {
  it.each([false, true])(
    "validates an AI-era snapshot (deployment receipt: %s) and scrubs AI state on the original schema",
    async (hasDeploymentReceipt) => {
      const extraSql =
        aiSeedSql +
        (hasDeploymentReceipt
          ? migrationReceiptTableSql +
            `INSERT INTO deployment_migrations VALUES (1,'source-db','{}');`
          : "")
      const snapshot = await writeSql(
        await createDump(extraSql, aiLedgerSql, aiServiceSql),
      )

      const inspection = await inspectBackupSql(
        snapshot,
        fullRepositoryMigrations,
      )
      expect(inspection.hasAiApplicationTables).toBe(true)
      expect(inspection.hasDeploymentReceipt).toBe(hasDeploymentReceipt)
      expect(inspection.migration).toMatchObject({
        count: 2,
        latestId: 2,
        latestName: "0002_ai_service.sql",
      })

      const scrub = createCredentialScrubSql({
        hasAiApplicationTables: true,
        hasDeploymentReceipt: hasDeploymentReceipt,
      })
      expect(scrub).toContain('DELETE FROM "ai_authorization_sessions";')
      expect(scrub).toContain(
        `UPDATE "ai_connections" SET "credentialCiphertext" = NULL`,
      )
      expect(scrub).toContain(
        `UPDATE "ai_invocations" SET "status" = 'unknown'`,
      )
      expect(scrub).not.toMatch(/\b(?:BEGIN|COMMIT)\b/)
      expect(scrub).not.toContain("ai_models")
      expect(scrub).not.toContain('DELETE FROM "ai_connections"')
    },
  )

  it("keeps the AI scrub executable against the real AI schema and preserves reference data", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      database.exec(foundationSql)
      database.exec(aiServiceSql)
      database.exec(aiSeedSql)

      database.exec(
        `BEGIN IMMEDIATE;\n${createCredentialScrubSql({ hasAiApplicationTables: true })}\nCOMMIT;`,
      )

      expect(
        database.prepare("SELECT * FROM ai_authorization_sessions").all(),
      ).toEqual([])

      expect(
        database
          .prepare(
            "SELECT authorizationStatus, upstreamAccountId, credentialVersion, credentialCiphertext, credentialExpiresAt, refreshClaimId, refreshClaimExpiresAt FROM ai_connections WHERE id = ?",
          )
          .get(connectedConnectionId),
      ).toEqual({
        authorizationStatus: "reauthentication_required",
        upstreamAccountId: "account-50254496",
        credentialVersion: 4,
        credentialCiphertext: null,
        credentialExpiresAt: null,
        refreshClaimId: null,
        refreshClaimExpiresAt: null,
      })

      expect(
        database
          .prepare(
            "SELECT authorizationStatus, credentialVersion FROM ai_connections WHERE id = ?",
          )
          .get(freshConnectionId),
      ).toEqual({
        authorizationStatus: "never_authorized",
        credentialVersion: 0,
      })

      // Model snapshots survive only as reference data with their original
      // snapshot version, which no longer matches the advanced connection.
      expect(
        database
          .prepare(
            "SELECT upstreamModelId, snapshotCredentialVersion FROM ai_models ORDER BY upstreamModelId",
          )
          .all(),
      ).toEqual([
        { upstreamModelId: "GPT-6-Astra", snapshotCredentialVersion: 3 },
        { upstreamModelId: "gpt-6-astra", snapshotCredentialVersion: 3 },
      ])

      // The in-flight reservation becomes unknown at its lease boundary; the
      // terminal record and its recorded usage are preserved as-is.
      expect(
        database
          .prepare(
            "SELECT status, endedAt, usage FROM ai_invocations WHERE requestId = '88888888-8888-4888-8888-888888888880'",
          )
          .get(),
      ).toEqual({ status: "unknown", endedAt: 1799993030000, usage: null })
      expect(
        database
          .prepare(
            "SELECT status, endedAt, upstreamRequestId, usage FROM ai_invocations WHERE requestId = '88888888-8888-4888-8888-888888888881'",
          )
          .get(),
      ).toEqual({
        status: "succeeded",
        endedAt: 1799983000000,
        upstreamRequestId: "req_upstream_1",
        usage: '{"input_tokens":12,"output_tokens":34}',
      })
    } finally {
      database.close()
    }
  })

  it.each([false, true])(
    "keeps 0001-only snapshots valid against the full repository manifest without AI statements (deployment receipt: %s)",
    async (hasDeploymentReceipt) => {
      const extraSql = hasDeploymentReceipt
        ? migrationReceiptTableSql +
          `INSERT INTO deployment_migrations VALUES (1,'source-db','{}');`
        : ""
      const snapshot = await writeSql(await createDump(extraSql))

      const inspection = await inspectBackupSql(
        snapshot,
        fullRepositoryMigrations,
      )
      expect(inspection.hasAiApplicationTables).toBe(false)
      expect(inspection.migration).toMatchObject({
        count: 1,
        latestName: "0001_foundation.sql",
      })

      const scrub = createCredentialScrubSql({
        hasAiApplicationTables: false,
        hasDeploymentReceipt: inspection.hasDeploymentReceipt,
      })
      expect(scrub).not.toContain("ai_")
      // The 0001-only scrub stays executable on the 0001 schema: running it
      // with AI statements would fail on missing tables.
      const database = new DatabaseSync(":memory:")
      try {
        database.exec(foundationSql)
        if (inspection.hasDeploymentReceipt)
          database.exec(migrationReceiptTableSql)
        database.exec(`BEGIN IMMEDIATE;\n${scrub}\nCOMMIT;`)
      } finally {
        database.close()
      }
    },
  )

  it("preserves invocation rows and their identity while the admission migration relaxes the identity columns", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      // The migration is applied forward to a database that already holds the
      // 0002-era rows, which is what a production upgrade does.
      database.exec(foundationSql)
      database.exec(aiServiceSql)
      database.exec(aiSeedSql)
      database.exec(invocationAdmissionSql)

      expect(
        database
          .prepare(
            'SELECT "requestId", "connectionId", "upstreamModelId", "status", "endedAt", "upstreamRequestId", "usage" FROM "ai_invocations" ORDER BY "requestId"',
          )
          .all(),
      ).toEqual([
        {
          connectionId: connectedConnectionId,
          endedAt: null,
          requestId: "88888888-8888-4888-8888-888888888880",
          status: "reserved",
          upstreamModelId: "gpt-6-astra",
          upstreamRequestId: null,
          usage: null,
        },
        {
          connectionId: connectedConnectionId,
          endedAt: 1799983000000,
          requestId: "88888888-8888-4888-8888-888888888881",
          status: "succeeded",
          upstreamModelId: "gpt-6-astra",
          upstreamRequestId: "req_upstream_1",
          usage: '{"input_tokens":12,"output_tokens":34}',
        },
      ])

      // The identity columns are nullable now, and an unidentified
      // reservation is exactly that: no identity, never a fabricated one.
      const columns = database
        .prepare('PRAGMA main.table_xinfo("ai_invocations")')
        .all() as { name: string; notnull: number }[]
      expect(
        columns
          .filter(
            (column) =>
              column.name === "connectionId" ||
              column.name === "upstreamModelId",
          )
          .map((column) => column.notnull),
      ).toEqual([0, 0])
      database.exec(aiUnidentifiedInvocationSeedSql)

      // The rebuilt table keeps its indexes and its checks.
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'ai_invocations' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "ai_invocations_inflight_apiKey_lease_idx" },
        { name: "ai_invocations_inflight_lease_idx" },
        { name: "ai_invocations_startedAt_requestId_idx" },
      ])
      expect(() =>
        database.exec(
          `INSERT INTO "ai_invocations" VALUES ('88888888-8888-4888-8888-888888888883', 'key-4', NULL, NULL, 1799991000000, 1799994000000, 1799994030000, 'unknown', NULL, NULL, NULL, NULL);`,
        ),
      ).toThrow(/CHECK constraint failed/u)
    } finally {
      database.close()
    }
  })

  it.each([false, true])(
    "validates an admission-era snapshot against the full manifest (deployment receipt: %s)",
    async (hasDeploymentReceipt) => {
      const extraSql =
        aiAdmissionSeedSql +
        (hasDeploymentReceipt
          ? migrationReceiptTableSql +
            `INSERT INTO deployment_migrations VALUES (1,'source-db','{}');`
          : "")
      const snapshot = await writeSql(
        await createDump(
          extraSql,
          aiAdmissionLedgerSql,
          admissionEraAiSchemaSql(),
        ),
      )

      const inspection = await inspectBackupSql(
        snapshot,
        fullRepositoryMigrations,
      )
      expect(inspection.hasAiApplicationTables).toBe(true)
      expect(inspection.migration).toMatchObject({
        count: 3,
        latestId: 3,
        latestName: "0003_invocation_admission.sql",
      })

      // The scrub runs on the snapshot's original schema, which is the
      // admission-era schema here: it must stay executable against it.
      const scrub = createCredentialScrubSql({
        hasAiApplicationTables: true,
        hasDeploymentReceipt: hasDeploymentReceipt,
      })
      const database = new DatabaseSync(":memory:")
      try {
        database.exec(foundationSql)
        database.exec(aiServiceSql)
        database.exec(invocationAdmissionSql)
        database.exec(aiAdmissionSeedSql)
        if (hasDeploymentReceipt) database.exec(migrationReceiptTableSql)
        database.exec(`BEGIN IMMEDIATE;\n${scrub}\nCOMMIT;`)
        expect(
          database
            .prepare(
              "SELECT status, endedAt, connectionId FROM ai_invocations WHERE requestId = '88888888-8888-4888-8888-888888888882'",
            )
            .get(),
        ).toEqual({
          connectionId: null,
          endedAt: 1799994030000,
          status: "unknown",
        })
      } finally {
        database.close()
      }
    },
  )

  it("rejects AI tables in a snapshot whose ledger claims only 0001", async () => {
    const snapshot = await writeSql(
      await createDump(aiSeedSql, undefined, aiServiceSql),
    )
    await expect(
      inspectBackupSql(snapshot, fullRepositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it("rejects a partial AI table set despite a full migration ledger", async () => {
    const schemaCutIndex = aiServiceSql.indexOf("-- Model catalog snapshots")
    expect(schemaCutIndex).toBeGreaterThan(0)
    const partialAiSchemaSql = aiServiceSql.slice(0, schemaCutIndex)
    // Only seed rows for tables the partial schema actually defines, so the
    // rejection comes from the schema-versus-ledger check itself.
    const snapshot = await writeSql(
      await createDump(
        `${aiConnectionSeedSql}\n${aiSessionSeedSql}`,
        aiLedgerSql,
        partialAiSchemaSql,
      ),
    )
    await expect(
      inspectBackupSql(snapshot, fullRepositoryMigrations),
    ).rejects.toThrow("isolated semantic restore validation")
  })

  it(
    "the restore CLI validates an AI-era snapshot and orders scrub before forward migrations",
    { timeout: 60_000 },
    async () => {
      const repositoryRoot = path.resolve(".")
      const sql = await createDump(aiSeedSql, aiLedgerSql, aiServiceSql)
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "eruoo-restore-cli-"),
      )
      temporaryDirectories.push(directory)

      const object = createBackupObjectDescriptor({
        createdAt: "2026-09-18T19:00:00.000Z",
        exportBookmark: "bookmark-ai",
        revision: {
          id: "11111111-1111-4111-8111-111111111111",
          tag: "production",
          timestamp: "2026-09-18T18:55:00.000Z",
        },
        workflowInstanceId: "backup-instance-ai",
      })
      const snapshotPath = path.join(directory, path.basename(object.key))
      await writeFile(snapshotPath, sql, "utf8")
      const snapshotBytes = await readFile(snapshotPath)
      const planDescriptor = {
        ...object,
        customMetadata: {
          ...object.customMetadata,
          contentLength: String(snapshotBytes.byteLength),
        },
        etag: createHash("md5").update(snapshotBytes).digest("hex"),
        size: snapshotBytes.byteLength,
        httpMetadata: { contentType: "application/sql" },
        storageClass: "Standard",
      }
      const descriptorPath = path.join(directory, "descriptor.json")
      await writeFile(descriptorPath, JSON.stringify(planDescriptor))

      const { stdout } = await execFileAsync(
        path.join(repositoryRoot, "node_modules", ".bin", "tsx"),
        [
          "scripts/restore-database.ts",
          "--descriptor",
          descriptorPath,
          "--snapshot",
          snapshotPath,
          "--target-database-id",
          "22222222-2222-4222-8222-222222222222",
          "--target-database",
          "eruoo-server-restore-20260918",
          "--production-database-id",
          "11111111-1111-4111-8111-111111111111",
        ],
        { cwd: repositoryRoot },
      )

      const plan = JSON.parse(stdout) as {
        generatedSql: {
          credentialScrub: string
          targetMigrationReceipt: string
        }
        migrationState: { count: number; latestName: string }
        nextAuthorizedSteps: string[]
        status: string
      }
      expect(plan.status).toBe("validated-local-plan-only")
      expect(plan.migrationState).toMatchObject({
        count: 2,
        latestName: "0002_ai_service.sql",
      })
      expect(plan.generatedSql.credentialScrub).toContain(
        'DELETE FROM "ai_authorization_sessions";',
      )
      expect(plan.generatedSql.credentialScrub).not.toMatch(
        /\b(?:BEGIN|COMMIT)\b/,
      )
      expect(plan.generatedSql.targetMigrationReceipt).toContain(
        "0002_ai_service.sql",
      )
      expect(plan.generatedSql.targetMigrationReceipt).toContain(
        "0003_invocation_admission.sql",
      )

      // The plan's step order must match the local semantic validation:
      // scrub on the original schema strictly before forward migrations.
      const scrubStep = plan.nextAuthorizedSteps.findIndex((step) =>
        step.includes("credentialScrub"),
      )
      const migrationStep = plan.nextAuthorizedSteps.findIndex((step) =>
        step.includes("Apply repository migrations"),
      )
      expect(scrubStep).toBeGreaterThan(-1)
      expect(migrationStep).toBeGreaterThan(-1)
      expect(scrubStep).toBeLessThan(migrationStep)

      // The generated scrub must be executable on the original snapshot
      // schema (0001 + 0002, pre-migration), which is where the plan runs it.
      const database = new DatabaseSync(":memory:")
      try {
        database.exec(foundationSql)
        database.exec(aiServiceSql)
        database.exec(aiSeedSql)
        database.exec(
          `BEGIN IMMEDIATE;\n${plan.generatedSql.credentialScrub}\nCOMMIT;`,
        )
        expect(
          database
            .prepare("SELECT 1 FROM ai_invocations WHERE status = 'reserved'")
            .all(),
        ).toEqual([])
      } finally {
        database.close()
      }
    },
  )
})

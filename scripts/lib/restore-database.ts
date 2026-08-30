import { constants as bufferConstants } from "node:buffer"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { constants as sqliteConstants, DatabaseSync } from "node:sqlite"

import { z } from "zod"

import {
  enabledOAuthClients,
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
  oauthScopes,
  OAUTH_RESOURCE,
} from "../../src/shared/oauth"
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_SINGLE_OBJECT_MAX_BYTES,
} from "../../src/worker/backup/constants"
import { createBackupObjectDescriptor } from "../../src/worker/backup/storage"
import { isProductionMigrationFileName } from "./production-migrations"

const uuidPattern =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i
const targetDatabaseNamePattern =
  /^eruoo-server-restore-[a-z0-9]+(?:-[a-z0-9]+)*$/
const d1MigrationsTableSql = `
  CREATE TABLE "d1_migrations" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "name" TEXT UNIQUE,
    "applied_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
`

const requiredCustomMetadataKeys = [
  "auditEvents",
  "backupContents",
  "backupFormat",
  "contentLength",
  "createdAt",
  "credentials",
  "exportBookmark",
  "sourceRevision",
  "sourceRevisionTag",
  "sourceRevisionTimestamp",
  "workflowInstanceId",
] as const

const backupDescriptorSchema = z
  .object({
    customMetadata: z.record(z.string(), z.string()),
    etag: z.string().regex(/^[a-f\d]{32}$/i),
    httpMetadata: z
      .object({ contentType: z.literal("application/sql") })
      .strict(),
    key: z.string().min(1),
    size: z
      .int()
      .positive()
      .max(BACKUP_SINGLE_OBJECT_MAX_BYTES - 1),
    storageClass: z.literal("Standard"),
  })
  .strict()

export interface ValidatedBackupDescriptor {
  createdAt: string
  customMetadata: Record<string, string>
  exportBookmark: string
  etag: string
  key: string
  revision: {
    id: string
    tag: string
    timestamp: string
  }
  size: number
  workflowInstanceId: string
}

export interface InspectedBackupSql {
  migration: {
    count: number
    digest: string
    latestAppliedAt: string
    latestId: number
    latestName: string
  }
  rawBytes: number
  md5: string
  sha256: string
}

export interface RestoreTarget {
  databaseId: string
  databaseName: string
  productionDatabaseId: string
}

export interface RepositoryMigration {
  name: string
  sql: string
}

interface SqliteSchemaRow {
  name: string
  sql: string | null
  tableName: string
  type: string
}

interface SqliteMigrationRow {
  applied_at: number | string
  id: number
  name: string
}

interface SqliteTableXinfoRow {
  cid: number
  dflt_value: string | null
  hidden: number
  name: string
  notnull: number
  pk: number
  type: string
}

interface SqliteIndexListRow {
  name: string
  origin: string
  partial: number
  seq: number
  unique: number
}

interface SqliteIndexXinfoRow {
  cid: number
  coll: string | null
  desc: number
  key: number
  name: string | null
  seqno: number
}

function parseCanonicalIsoDate(value: string, label: string): string {
  const timestamp = Date.parse(value)
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function hasExactKeys(
  value: Record<string, string>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  )
}

export function validateBackupDescriptor(
  input: unknown,
): ValidatedBackupDescriptor {
  const descriptor = backupDescriptorSchema.parse(input)
  const metadata = descriptor.customMetadata

  if (!hasExactKeys(metadata, requiredCustomMetadataKeys)) {
    throw new Error("Backup custom metadata has an unexpected shape.")
  }
  if (
    metadata["backupFormat"] !== BACKUP_FORMAT_VERSION ||
    metadata["backupContents"] !== "full-database" ||
    metadata["auditEvents"] !== "included" ||
    metadata["credentials"] !== "included"
  ) {
    throw new Error("Backup custom metadata violates the restore contract.")
  }

  const createdAt = parseCanonicalIsoDate(
    metadata["createdAt"] ?? "",
    "createdAt",
  )
  const sourceRevisionTimestamp = parseCanonicalIsoDate(
    metadata["sourceRevisionTimestamp"] ?? "",
    "sourceRevisionTimestamp",
  )
  const exportBookmark = metadata["exportBookmark"] ?? ""
  const sourceRevision = metadata["sourceRevision"] ?? ""
  const sourceRevisionTag = metadata["sourceRevisionTag"] ?? ""
  const workflowInstanceId = metadata["workflowInstanceId"] ?? ""
  const expectedDescriptor = createBackupObjectDescriptor({
    createdAt,
    exportBookmark,
    revision: {
      id: sourceRevision,
      tag: sourceRevisionTag,
      timestamp: sourceRevisionTimestamp,
    },
    workflowInstanceId,
  })

  if (
    metadata["contentLength"] !== String(descriptor.size) ||
    descriptor.key !== expectedDescriptor.key ||
    Object.entries(expectedDescriptor.customMetadata).some(
      ([key, value]) => metadata[key] !== value,
    )
  ) {
    throw new Error("Backup key and metadata identity do not match.")
  }

  return {
    createdAt,
    customMetadata: metadata,
    etag: descriptor.etag.toLowerCase(),
    exportBookmark,
    key: descriptor.key,
    revision: {
      id: sourceRevision,
      tag: sourceRevisionTag,
      timestamp: sourceRevisionTimestamp,
    },
    size: descriptor.size,
    workflowInstanceId,
  }
}

export function validateRestoreTarget(target: RestoreTarget): RestoreTarget {
  if (
    !targetDatabaseNamePattern.test(target.databaseName) ||
    !uuidPattern.test(target.databaseId) ||
    !uuidPattern.test(target.productionDatabaseId) ||
    target.databaseId.toLowerCase() ===
      target.productionDatabaseId.toLowerCase()
  ) {
    throw new Error(
      "Restore target must be an explicitly named isolated D1 distinct from production.",
    )
  }

  return target
}

function isMainDatabase(databaseName: string | null): boolean {
  return databaseName === "main"
}

function isSafeSchemaName(name: string | null): boolean {
  return name !== null && !name.toLowerCase().startsWith("sqlite_")
}

function isAllowedSchemaIntrospectionPragma(
  pragmaName: string | null,
  pragmaArgument: string | null,
  databaseName: string | null,
): boolean {
  if (!isMainDatabase(databaseName)) return false

  switch (pragmaName?.toLowerCase()) {
    case "index_list":
    case "table_xinfo":
      return pragmaArgument === "d1_migrations"
    case "index_xinfo":
      return (
        isSafeSchemaName(pragmaArgument) ||
        pragmaArgument === "sqlite_autoindex_d1_migrations_1"
      )
    default:
      return false
  }
}

function createImportAuthorizer() {
  return (
    actionCode: number,
    argument1: string | null,
    argument2: string | null,
    databaseName: string | null,
    triggerOrView: string | null,
  ): number => {
    if (triggerOrView !== null) return sqliteConstants.SQLITE_DENY

    switch (actionCode) {
      case sqliteConstants.SQLITE_CREATE_TABLE:
        return isMainDatabase(databaseName) &&
          (isSafeSchemaName(argument1) || argument1 === "sqlite_sequence")
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_CREATE_INDEX:
        return isMainDatabase(databaseName) &&
          (isSafeSchemaName(argument1) ||
            (argument1?.startsWith("sqlite_autoindex_") === true &&
              isSafeSchemaName(argument2)))
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_INSERT:
        return isMainDatabase(databaseName) &&
          (isSafeSchemaName(argument1) ||
            argument1 === "sqlite_master" ||
            argument1 === "sqlite_sequence")
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_DELETE:
        return isMainDatabase(databaseName) && argument1 === "sqlite_sequence"
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_UPDATE:
        return isMainDatabase(databaseName) && argument1 === "sqlite_master"
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_READ:
        return isMainDatabase(databaseName)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_REINDEX:
        return isMainDatabase(databaseName) && isSafeSchemaName(argument1)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_PRAGMA:
        return argument1?.toLowerCase() === "defer_foreign_keys" &&
          ["1", "on", "true"].includes(argument2?.toLowerCase() ?? "")
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_TRANSACTION:
        return ["begin", "commit", "rollback"].includes(
          argument1?.toLowerCase() ?? "",
        )
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      default:
        return sqliteConstants.SQLITE_DENY
    }
  }
}

function createReadOnlyAuthorizer() {
  return (
    actionCode: number,
    _argument1: string | null,
    _argument2: string | null,
    databaseName: string | null,
    triggerOrView: string | null,
  ): number => {
    if (triggerOrView !== null) return sqliteConstants.SQLITE_DENY
    if (actionCode === sqliteConstants.SQLITE_SELECT) {
      return sqliteConstants.SQLITE_OK
    }
    if (
      actionCode === sqliteConstants.SQLITE_READ &&
      isMainDatabase(databaseName)
    ) {
      return sqliteConstants.SQLITE_OK
    }
    if (
      actionCode === sqliteConstants.SQLITE_PRAGMA &&
      isAllowedSchemaIntrospectionPragma(_argument1, _argument2, databaseName)
    ) {
      return sqliteConstants.SQLITE_OK
    }
    return sqliteConstants.SQLITE_DENY
  }
}

const scrubDeleteTables = new Set([
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthRefreshTokenFamilyRevocation",
  "oauthConsent",
  "oauthClientAssertion",
  "session",
  "verification",
  "apikey",
  "passkey",
  "rateLimit",
  "jwks",
  "oauthClientResource",
  "oauthClient",
  "oauthResource",
  "security_audit_events",
  "maintenance_lease",
  "database_backup_health",
])
const scrubInsertTables = new Set([
  "oauthClientResource",
  "oauthClient",
  "oauthResource",
])
const scrubEmptyTables = [
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthRefreshTokenFamilyRevocation",
  "oauthConsent",
  "oauthClientAssertion",
  "session",
  "verification",
  "apikey",
  "passkey",
  "rateLimit",
  "jwks",
  "security_audit_events",
  "maintenance_lease",
  "database_backup_health",
] as const
const scrubAccountColumns = new Set([
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "scope",
  "password",
])

function isAllowedScrubUpdate(
  table: string | null,
  column: string | null,
): boolean {
  return (
    (table === "account" &&
      column !== null &&
      scrubAccountColumns.has(column)) ||
    ((table === "oauthAccessToken" || table === "oauthRefreshToken") &&
      column === "sessionId")
  )
}

function createScrubAuthorizer() {
  return (
    actionCode: number,
    argument1: string | null,
    argument2: string | null,
    databaseName: string | null,
    triggerOrView: string | null,
  ): number => {
    if (triggerOrView !== null) return sqliteConstants.SQLITE_DENY
    switch (actionCode) {
      case sqliteConstants.SQLITE_DELETE:
        return isMainDatabase(databaseName) &&
          argument1 !== null &&
          scrubDeleteTables.has(argument1)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_INSERT:
        return isMainDatabase(databaseName) &&
          argument1 !== null &&
          scrubInsertTables.has(argument1)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_UPDATE:
        return isMainDatabase(databaseName) &&
          isAllowedScrubUpdate(argument1, argument2)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_READ:
        return isMainDatabase(databaseName)
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      case sqliteConstants.SQLITE_TRANSACTION:
        return ["begin", "commit", "rollback"].includes(
          argument1?.toLowerCase() ?? "",
        )
          ? sqliteConstants.SQLITE_OK
          : sqliteConstants.SQLITE_DENY
      default:
        return sqliteConstants.SQLITE_DENY
    }
  }
}

function queryAll<T extends object>(database: DatabaseSync, sql: string): T[] {
  return database.prepare(sql).all() as T[]
}

function validateRepositoryMigrationManifest(
  rows: readonly SqliteMigrationRow[],
  repositoryMigrations: readonly RepositoryMigration[],
): InspectedBackupSql["migration"] {
  const repositoryMigrationNames = repositoryMigrations.map(({ name }) => name)
  if (
    rows.length === 0 ||
    repositoryMigrationNames.length === 0 ||
    new Set(repositoryMigrationNames).size !==
      repositoryMigrationNames.length ||
    repositoryMigrationNames.some(
      (name) => !isProductionMigrationFileName(name),
    )
  ) {
    throw new Error(
      "Backup migration ledger or repository manifest is invalid.",
    )
  }

  const migrations = rows
    .map((row) => {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= 0 ||
        typeof row.name !== "string" ||
        row.name.length === 0 ||
        (typeof row.applied_at !== "string" &&
          typeof row.applied_at !== "number")
      ) {
        throw new Error("Backup d1_migrations contains an invalid row.")
      }
      return {
        appliedAt: String(row.applied_at),
        id: row.id,
        name: row.name,
      }
    })
    .sort((left, right) => left.id - right.id)

  if (
    migrations.length > repositoryMigrationNames.length ||
    migrations.some(
      (migration, index) =>
        migration.id !== index + 1 ||
        migration.name !== repositoryMigrationNames[index],
    )
  ) {
    throw new Error(
      "Backup d1_migrations is not an exact prefix of the repository migration manifest.",
    )
  }

  const latest = migrations.at(-1)
  if (latest === undefined) {
    throw new Error("Backup d1_migrations is empty.")
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(migrations))
    .digest("hex")

  return {
    count: migrations.length,
    digest,
    latestAppliedAt: latest.appliedAt,
    latestId: latest.id,
    latestName: latest.name,
  }
}

function normalizeSchemaStatement(statement: string | null): string | null {
  return statement?.trim().replaceAll(/\s+/g, " ") ?? null
}

function normalizeD1MigrationsTableStatement(
  statement: string | null,
): string | null {
  return (
    normalizeSchemaStatement(statement)
      ?.replaceAll(/["`[\]]/g, "")
      .replaceAll(/\s*([(),])\s*/g, "$1")
      .toLowerCase() ?? null
  )
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function d1MigrationsSchema(
  database: DatabaseSync,
  schema: readonly SqliteSchemaRow[],
) {
  const table = schema.find(
    (row) => row.type === "table" && row.name === "d1_migrations",
  )
  const columns = queryAll<SqliteTableXinfoRow>(
    database,
    'PRAGMA main.table_xinfo("d1_migrations")',
  )
  const indexes = queryAll<SqliteIndexListRow>(
    database,
    'PRAGMA main.index_list("d1_migrations")',
  )
    .map((index) => ({
      columns: queryAll<SqliteIndexXinfoRow>(
        database,
        `PRAGMA main.index_xinfo(${quoteSqliteIdentifier(index.name)})`,
      ).sort((left, right) => left.seqno - right.seqno),
      name: index.name,
      origin: index.origin,
      partial: index.partial,
      unique: index.unique,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))

  return {
    columns: columns.sort((left, right) => left.cid - right.cid),
    indexes,
    tableSql: normalizeD1MigrationsTableStatement(table?.sql ?? null),
  }
}

function assertD1MigrationsSchema(
  actualDatabase: DatabaseSync,
  actualSchema: readonly SqliteSchemaRow[],
): void {
  const expectedDatabase = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  })
  expectedDatabase.enableDefensive(true)
  expectedDatabase.enableLoadExtension(false)

  try {
    expectedDatabase.exec(d1MigrationsTableSql)
    const expectedSchema = queryAll<SqliteSchemaRow>(
      expectedDatabase,
      'SELECT type, name, tbl_name AS "tableName", sql FROM sqlite_schema ORDER BY type, name',
    )
    if (
      JSON.stringify(d1MigrationsSchema(actualDatabase, actualSchema)) !==
      JSON.stringify(d1MigrationsSchema(expectedDatabase, expectedSchema))
    ) {
      throw new Error(
        "Backup d1_migrations schema does not match Wrangler's migration ledger contract.",
      )
    }
  } finally {
    expectedDatabase.close()
  }
}

function applicationSchema(rows: readonly SqliteSchemaRow[]) {
  return rows
    .filter(
      (row) =>
        row.name !== "d1_migrations" &&
        row.tableName !== "d1_migrations" &&
        !row.name.toLowerCase().startsWith("sqlite_") &&
        !row.tableName.toLowerCase().startsWith("sqlite_"),
    )
    .map((row) => ({
      name: row.name,
      sql: normalizeSchemaStatement(row.sql),
      tableName: row.tableName,
      type: row.type,
    }))
    .sort((left, right) =>
      `${left.type}\0${left.name}`.localeCompare(
        `${right.type}\0${right.name}`,
        "en",
      ),
    )
}

function assertRepositorySchema(
  actualSchema: readonly SqliteSchemaRow[],
  repositoryMigrations: readonly RepositoryMigration[],
  appliedMigrationCount: number,
): void {
  const expectedDatabase = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  })
  expectedDatabase.enableDefensive(true)
  expectedDatabase.enableLoadExtension(false)

  try {
    for (const migration of repositoryMigrations.slice(
      0,
      appliedMigrationCount,
    )) {
      expectedDatabase.exec(migration.sql)
    }
    const expectedSchema = queryAll<SqliteSchemaRow>(
      expectedDatabase,
      'SELECT type, name, tbl_name AS "tableName", sql FROM sqlite_schema ORDER BY type, name',
    )
    if (
      JSON.stringify(applicationSchema(actualSchema)) !==
      JSON.stringify(applicationSchema(expectedSchema))
    ) {
      throw new Error(
        "Backup application schema does not match its repository migration prefix.",
      )
    }
  } finally {
    expectedDatabase.close()
  }
}

function assertScrubbed(database: DatabaseSync): void {
  for (const table of scrubEmptyTables) {
    const rows = queryAll(database, `SELECT * FROM "${table}" LIMIT 1`)
    if (rows.length !== 0) {
      throw new Error(`Credential scrub left rows in ${table}.`)
    }
  }

  const sensitiveAccounts = queryAll(
    database,
    'SELECT "id" FROM "account" WHERE "accessToken" IS NOT NULL OR "refreshToken" IS NOT NULL OR "idToken" IS NOT NULL OR "accessTokenExpiresAt" IS NOT NULL OR "refreshTokenExpiresAt" IS NOT NULL OR "scope" IS NOT NULL OR "password" IS NOT NULL LIMIT 1',
  )
  if (sensitiveAccounts.length !== 0) {
    throw new Error("Credential scrub left sensitive account fields populated.")
  }

  const actualClients = queryAll<{ clientId: string }>(
    database,
    'SELECT "clientId" FROM "oauthClient" ORDER BY "clientId"',
  ).map(({ clientId }) => clientId)
  const expectedClients = enabledOAuthClients
    .map(({ clientId }) => clientId)
    .sort((left, right) => left.localeCompare(right, "en"))
  if (JSON.stringify(actualClients) !== JSON.stringify(expectedClients)) {
    throw new Error(
      "Credential scrub did not restore the static OAuth clients.",
    )
  }

  const resources = queryAll<{ identifier: string }>(
    database,
    'SELECT "identifier" FROM "oauthResource"',
  )
  if (resources.length !== 1 || resources[0]?.identifier !== OAUTH_RESOURCE) {
    throw new Error(
      "Credential scrub did not restore the static OAuth resource.",
    )
  }

  const links = queryAll<{ clientId: string; resourceId: string }>(
    database,
    'SELECT "clientId", "resourceId" FROM "oauthClientResource" ORDER BY "clientId"',
  )
  if (
    links.length !== expectedClients.length ||
    links.some(
      (link, index) =>
        link.clientId !== expectedClients[index] ||
        link.resourceId !== OAUTH_RESOURCE,
    )
  ) {
    throw new Error("Credential scrub did not restore static OAuth links.")
  }
}

export async function inspectBackupSql(
  filePath: string,
  repositoryMigrations: readonly RepositoryMigration[],
): Promise<InspectedBackupSql> {
  if (!filePath.endsWith(".sql")) {
    throw new Error("Backup snapshot must use the .sql suffix.")
  }

  const file = await stat(filePath)
  if (
    !file.isFile() ||
    file.size <= 0 ||
    file.size >= BACKUP_SINGLE_OBJECT_MAX_BYTES ||
    file.size > bufferConstants.MAX_STRING_LENGTH
  ) {
    throw new Error(
      "Backup snapshot exceeds the safe local SQLite planning size.",
    )
  }

  const bytes = await readFile(filePath)
  const sql = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  }).decode(bytes)
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
  })
  database.enableDefensive(true)
  database.enableLoadExtension(false)

  try {
    database.setAuthorizer(createImportAuthorizer())
    database.exec(sql)
    if (database.isTransaction) {
      throw new Error("Backup SQL leaves a transaction open.")
    }

    database.setAuthorizer(createReadOnlyAuthorizer())
    const schema = queryAll<SqliteSchemaRow>(
      database,
      'SELECT type, name, tbl_name AS "tableName", sql FROM sqlite_schema ORDER BY type, name',
    )
    const tables = new Set(
      schema.filter(({ type }) => type === "table").map(({ name }) => name),
    )
    if (
      !tables.has("d1_migrations") ||
      !tables.has("security_audit_events") ||
      schema.some(({ type }) => type === "trigger" || type === "view") ||
      schema.some(({ sql: statement }) =>
        statement?.toUpperCase().includes("CREATE VIRTUAL TABLE"),
      )
    ) {
      throw new Error("Backup SQLite schema violates the restore contract.")
    }
    assertD1MigrationsSchema(database, schema)

    const migrations = queryAll<SqliteMigrationRow>(
      database,
      'SELECT "id", "name", "applied_at" FROM "d1_migrations" ORDER BY "id"',
    )
    const migration = validateRepositoryMigrationManifest(
      migrations,
      repositoryMigrations,
    )
    assertRepositorySchema(schema, repositoryMigrations, migration.count)

    database.setAuthorizer(createScrubAuthorizer())
    database.exec(`BEGIN IMMEDIATE;\n${createCredentialScrubSql()}\nCOMMIT;`)
    database.setAuthorizer(createReadOnlyAuthorizer())
    assertScrubbed(database)

    return {
      migration,
      md5: createHash("md5").update(bytes).digest("hex"),
      rawBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  } catch (error) {
    throw new Error("Backup SQL failed isolated semantic restore validation.", {
      cause: error,
    })
  } finally {
    database.close()
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function createStaticOAuthSeedSql(): string {
  const statements = [
    `INSERT INTO "oauthResource" ("id", "identifier", "name", "accessTokenTtl", "refreshTokenTtl", "signingAlgorithm", "allowedScopes", "dpopBoundAccessTokensRequired", "disabled", "createdAt", "updatedAt", "policyVersion", "metadata") VALUES ('static-eruoo-api', ${sqlLiteral(OAUTH_RESOURCE)}, 'eruoo API', 3600, ${OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS}, 'EdDSA', ${sqlLiteral(JSON.stringify(oauthScopes))}, 0, 0, 0, 0, 1, '{"managedBy":"restore"}');`,
  ]

  for (const client of enabledOAuthClients) {
    statements.push(
      `INSERT INTO "oauthClient" ("id", "clientId", "disabled", "skipConsent", "enableEndSession", "subjectType", "scopes", "createdAt", "updatedAt", "name", "redirectUris", "tokenEndpointAuthMethod", "applicationType", "grantTypes", "responseTypes", "requirePKCE", "dpopBoundAccessTokens", "metadata") VALUES (${sqlLiteral(`static-${client.clientId}`)}, ${sqlLiteral(client.clientId)}, 0, 1, 1, 'public', ${sqlLiteral(JSON.stringify(client.scopes))}, 0, 0, ${sqlLiteral(client.name)}, ${sqlLiteral(JSON.stringify(client.redirectUris))}, 'none', ${sqlLiteral(client.applicationType)}, '["authorization_code","refresh_token"]', '["code"]', 1, 0, '{"managedBy":"restore"}');`,
      `INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "metadata", "createdAt") VALUES (${sqlLiteral(`static-${client.clientId}-api`)}, ${sqlLiteral(client.clientId)}, ${sqlLiteral(OAUTH_RESOURCE)}, '{"managedBy":"restore"}', 0);`,
    )
  }

  return statements.join("\n")
}

export function createCredentialScrubSql(): string {
  return [
    'DELETE FROM "oauthAccessToken";',
    'DELETE FROM "oauthRefreshToken";',
    'DELETE FROM "oauthRefreshTokenFamilyRevocation";',
    'DELETE FROM "oauthConsent";',
    'DELETE FROM "oauthClientAssertion";',
    'DELETE FROM "session";',
    'DELETE FROM "verification";',
    'DELETE FROM "apikey";',
    'DELETE FROM "passkey";',
    'DELETE FROM "rateLimit";',
    'DELETE FROM "jwks";',
    'DELETE FROM "oauthClientResource";',
    'DELETE FROM "oauthClient";',
    'DELETE FROM "oauthResource";',
    'UPDATE "account" SET "accessToken" = NULL, "refreshToken" = NULL, "idToken" = NULL, "accessTokenExpiresAt" = NULL, "refreshTokenExpiresAt" = NULL, "scope" = NULL, "password" = NULL;',
    'DELETE FROM "security_audit_events";',
    'DELETE FROM "maintenance_lease";',
    'DELETE FROM "database_backup_health";',
    createStaticOAuthSeedSql(),
  ].join("\n")
}

export function createRestoreCompletedAuditSql(options: {
  occurredAt: number
  requestId: string
  restoreId: string
  sourceRevision: string
}): string {
  if (
    !Number.isSafeInteger(options.occurredAt) ||
    options.occurredAt < 0 ||
    !uuidPattern.test(options.requestId) ||
    !uuidPattern.test(options.restoreId) ||
    options.sourceRevision.length === 0 ||
    options.sourceRevision.length > 128
  ) {
    throw new Error("Restore completion audit identity is invalid.")
  }

  const metadata = JSON.stringify({
    restoreId: options.restoreId,
    sourceRevision: options.sourceRevision,
  })
  return `INSERT INTO "security_audit_events" ("id", "type", "outcome", "occurredAt", "subjectId", "credentialId", "clientId", "ipFingerprint", "requestId", "metadata") VALUES (${sqlLiteral(options.restoreId)}, 'database_restore_completed', 'success', ${options.occurredAt}, NULL, NULL, NULL, NULL, ${sqlLiteral(options.requestId)}, ${sqlLiteral(metadata)});`
}

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

import {
  assertNoVirtualTables,
  createAuthSchemaSql,
  disallowVirtualTableCreation,
} from "./lib/auth-schema"

const authTableNames = [
  "account",
  "apikey",
  "jwks",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
  "passkey",
  "rateLimit",
  "session",
  "user",
  "verification",
] as const

const applicationManagedAuthIndexes = new Map([
  [
    "oauthAccessToken_expiresAt_idx",
    "create index oauthaccesstoken_expiresat_idx on oauthaccesstoken(expiresat)",
  ],
  [
    "oauthRefreshToken_expiresAt_idx",
    "create index oauthrefreshtoken_expiresat_idx on oauthrefreshtoken(expiresat)",
  ],
  [
    "oauthRefreshToken_family_expiresAt_idx",
    "create index oauthrefreshtoken_family_expiresat_idx on oauthrefreshtoken(authorizationcodeid,clientid,userid,expiresat)",
  ],
  [
    "oauthRefreshToken_rotationReplayExpiresAt_idx",
    "create index oauthrefreshtoken_rotationreplayexpiresat_idx on oauthrefreshtoken(rotationreplayexpiresat)",
  ],
  [
    "verification_expiresAt_idx",
    "create index verification_expiresat_idx on verification(expiresat)",
  ],
])

interface SchemaRow {
  name: string
  sql: string
  tbl_name: string
  type: string
}

function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),])\s*/g, "$1")
    .replaceAll('"', "")
    .trim()
    .toLowerCase()
}

function readAuthSchema(database: DatabaseSync): string[] {
  const placeholders = authTableNames.map(() => "?").join(", ")
  const rows = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE tbl_name IN (${placeholders}) AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all(...authTableNames) as unknown as SchemaRow[]

  return rows
    .filter(({ name }) => !applicationManagedAuthIndexes.has(name))
    .map(
      ({ name, sql, tbl_name: tableName, type }) =>
        `${type}:${name}:${tableName}:${normalizeSql(sql)}`,
    )
}

function assertApplicationManagedAuthIndexes(database: DatabaseSync): void {
  for (const [name, expectedSql] of applicationManagedAuthIndexes) {
    const row = database
      .prepare(
        `SELECT sql
         FROM sqlite_schema
         WHERE type = 'index' AND name = ?`,
      )
      .get(name) as { sql: string } | undefined

    if (!row || normalizeSql(row.sql) !== expectedSql) {
      throw new Error(`Application-managed auth index ${name} is invalid`)
    }
  }
}

if (!process.argv.includes("--check")) {
  throw new Error("Expected --check")
}

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
)
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort()

if (migrationFiles.length === 0) {
  throw new Error("No D1 migrations were found")
}

const migrationSql = (
  await Promise.all(
    migrationFiles.map((fileName) =>
      readFile(path.join(migrationsDirectory, fileName), "utf8"),
    ),
  )
).join("\n")

if (/\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(migrationSql)) {
  throw new Error("D1 virtual tables are not allowed by the backup contract")
}

const expected = new DatabaseSync(":memory:")
const actual = new DatabaseSync(":memory:")

try {
  expected.exec(await createAuthSchemaSql())
  disallowVirtualTableCreation(actual)
  actual.exec(migrationSql)
  assertNoVirtualTables(actual)
  assertApplicationManagedAuthIndexes(actual)

  const expectedSchema = readAuthSchema(expected)
  const actualSchema = readAuthSchema(actual)

  if (JSON.stringify(expectedSchema) !== JSON.stringify(actualSchema)) {
    const firstMismatch = Math.max(
      0,
      expectedSchema.findIndex((entry, index) => entry !== actualSchema[index]),
    )
    throw new Error(
      [
        "Better Auth schema drift detected.",
        `Expected: ${expectedSchema[firstMismatch] ?? "<missing>"}`,
        `Actual: ${actualSchema[firstMismatch] ?? "<missing>"}`,
      ].join("\n"),
    )
  }
} finally {
  actual.close()
  expected.close()
}

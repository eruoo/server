import { constants as sqliteConstants, DatabaseSync } from "node:sqlite"

import { getMigrations } from "better-auth/db/migration"

import { OWNER_GITHUB_ID } from "../../src/shared/security"
import { createAuthOptions } from "../../src/worker/auth"

const syntheticEnv = {
  ALLOWED_CORS_ORIGINS: "[]",
  APP_ENV: "development" as const,
  APP_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRETS: "1:synthetic-auth-schema-secret-not-used-at-runtime",
  GITHUB_CLIENT_ID: "synthetic-client-id",
  GITHUB_CLIENT_SECRET: "synthetic-client-secret",
  OWNER_GITHUB_ID,
} as const

export function disallowVirtualTableCreation(database: DatabaseSync): void {
  database.setAuthorizer((actionCode) =>
    actionCode === sqliteConstants.SQLITE_CREATE_VTABLE
      ? sqliteConstants.SQLITE_DENY
      : sqliteConstants.SQLITE_OK,
  )
}

export function assertNoVirtualTables(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE sql IS NOT NULL
       ORDER BY name`,
    )
    .all() as unknown as Array<{ name: string; sql: string }>
  const virtualTable = rows.find(({ sql }) =>
    /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql),
  )

  if (virtualTable) {
    throw new Error(
      `D1 virtual table ${virtualTable.name} is not allowed by the backup contract`,
    )
  }
}

export async function createAuthSchemaSql(): Promise<string> {
  const database = new DatabaseSync(":memory:")

  try {
    const options = createAuthOptions(syntheticEnv, database)
    const migrations = await getMigrations(options)
    return await migrations.compileMigrations()
  } finally {
    database.close()
  }
}

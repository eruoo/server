import { z } from "zod"

// Operational metadata is created before applying any application migration.
export const migrationReceiptTable = "deployment_migrations"
export const migrationReceiptTableSql = `CREATE TABLE IF NOT EXISTS "deployment_migrations" (
  "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
  "databaseId" TEXT NOT NULL,
  "migrations" TEXT NOT NULL
);`
const migrationHashes = z
  .record(
    z.string().regex(/^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/),
    z.string().regex(/^[a-f0-9]{64}$/),
  )
  .refine(
    (value) => Object.keys(value).length > 0,
    "Migration receipt cannot be empty",
  )
export type DeploymentQuery = (
  sql: string,
  params?: string[],
) => Promise<Record<string, unknown>[]>

export async function prepareMigrationReceipt(options: {
  query: DeploymentQuery
  databaseId: string
  migrations: Record<string, string>
  priorMigrations: Record<string, string>
  hasPriorDeployment: boolean
  tables: string[]
  ledger: string[]
}) {
  const { query, databaseId, tables, ledger } = options
  const current = migrationHashes.parse(options.migrations)
  const names = Object.keys(current).sort()
  if (ledger.some((name, index) => names[index] !== name))
    throw new Error("Unknown migration ledger prefix")
  let receipt: Record<string, string> | undefined
  if (tables.includes(migrationReceiptTable)) {
    const rows = await query(
      "SELECT databaseId, migrations FROM deployment_migrations WHERE id=1",
    )
    if (rows.length) {
      const row = z
        .object({ databaseId: z.literal(databaseId), migrations: z.string() })
        .parse(rows[0])
      receipt = migrationHashes.parse(JSON.parse(row.migrations))
    }
  }
  for (const recorded of [options.priorMigrations, receipt ?? {}])
    for (const [name, hash] of Object.entries(recorded))
      if (current[name] !== hash)
        throw new Error("A recorded migration was changed or removed")
  if (
    !options.hasPriorDeployment &&
    !receipt &&
    (ledger.length > 0 ||
      tables.some(
        (name) => ![migrationReceiptTable, "d1_migrations"].includes(name),
      ))
  )
    throw new Error(
      "Initial database is not empty and has no deployment receipt",
    )
  // A receipt survives a failed migration or Worker deployment; it never authorizes
  // an unrelated database or altered migration content on the next manual run.
  await query(migrationReceiptTableSql)
  await query(
    `INSERT INTO deployment_migrations (id, databaseId, migrations) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET databaseId=excluded.databaseId, migrations=excluded.migrations`,
    [databaseId, JSON.stringify(current)],
  )
}

export function createMigrationReceiptSql(
  databaseId: string,
  migrations: Record<string, string>,
): string {
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  return (
    migrationReceiptTableSql +
    `
INSERT INTO deployment_migrations (id, databaseId, migrations) VALUES (1, ${literal(databaseId)}, ${literal(JSON.stringify(migrationHashes.parse(migrations)))}) ON CONFLICT(id) DO UPDATE SET databaseId=excluded.databaseId, migrations=excluded.migrations;`
  )
}

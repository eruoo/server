import { DatabaseSync } from "node:sqlite"

import { afterEach, expect, it } from "vitest"

import {
  prepareMigrationReceipt,
  type DeploymentQuery,
} from "./migration-receipt"
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases) database.close()
  databases.length = 0
})
function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  const query: DeploymentQuery = async (sql, params = []) =>
    db.prepare(sql).all(...params) as Record<string, unknown>[]
  const migrations = { "0001_foundation.sql": "a".repeat(64) }
  const options = {
    query,
    databaseId: "new-db",
    migrations,
    priorMigrations: {},
    hasPriorDeployment: false,
    tables: [] as string[],
    ledger: [] as string[],
  }
  const inspect = () => {
    options.tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name))
  }
  return { db, options, inspect }
}
it("resumes after initial migration succeeds but deployment fails", async () => {
  const { db, options, inspect } = fixture()
  await prepareMigrationReceipt(options)
  db.exec("CREATE TABLE user (id TEXT);")
  inspect()
  options.ledger = ["0001_foundation.sql"]
  await expect(prepareMigrationReceipt(options)).resolves.toBeUndefined()
  await expect(
    prepareMigrationReceipt({ ...options, databaseId: "another-db" }),
  ).rejects.toThrow(/Invalid input/)
  await expect(
    prepareMigrationReceipt({
      ...options,
      migrations: { "0001_foundation.sql": "b".repeat(64) },
    }),
  ).rejects.toThrow("changed")
})
it("rejects unrelated populated databases even with matching migration names", async () => {
  const { db, options, inspect } = fixture()
  db.exec("CREATE TABLE user (id TEXT);")
  inspect()
  options.ledger = ["0001_foundation.sql"]
  await expect(prepareMigrationReceipt(options)).rejects.toThrow("not empty")
  expect(options.tables).not.toContain("deployment_migrations")
})
it("allows an empty retry and freezes planned hashes across partial migrations", async () => {
  const { db, options, inspect } = fixture()
  await prepareMigrationReceipt(options)
  inspect()
  await expect(prepareMigrationReceipt(options)).resolves.toBeUndefined()
  db.exec("CREATE TABLE user (id TEXT);")
  inspect()
  await expect(prepareMigrationReceipt(options)).resolves.toBeUndefined()
  await expect(
    prepareMigrationReceipt({ ...options, ledger: ["0002_other.sql"] }),
  ).rejects.toThrow("prefix")
})

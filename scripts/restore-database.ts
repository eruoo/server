import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import {
  createCredentialScrubSql,
  inspectBackupSql,
  validateBackupDescriptor,
  validateRestoreTarget,
} from "./lib/restore-database"

function readArgument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} argument.`)
  }
  return value
}

if (process.argv.includes("--execute")) {
  throw new Error(
    "This command only creates a locally validated restore plan; external restore execution requires separate owner authorization.",
  )
}

const descriptorPath = path.resolve(readArgument("--descriptor"))
const snapshotPath = path.resolve(readArgument("--snapshot"))
const descriptor = validateBackupDescriptor(
  JSON.parse(await readFile(descriptorPath, "utf8")),
)
const migrationDirectory = path.resolve("migrations")
const repositoryMigrationNames = (
  await readdir(migrationDirectory, {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"))
const repositoryMigrations = await Promise.all(
  repositoryMigrationNames.map(async (name) => ({
    name,
    sql: await readFile(path.join(migrationDirectory, name), "utf8"),
  })),
)
const target = validateRestoreTarget({
  databaseId: readArgument("--target-database-id"),
  databaseName: readArgument("--target-database"),
  productionDatabaseId: readArgument("--production-database-id"),
})

if (path.basename(snapshotPath) !== path.basename(descriptor.key)) {
  throw new Error("Local snapshot filename does not match the R2 object key.")
}
if ((await stat(snapshotPath)).size !== descriptor.size) {
  throw new Error("Local snapshot size does not match the R2 object metadata.")
}

const sql = await inspectBackupSql(snapshotPath, repositoryMigrations)
if (sql.md5 !== descriptor.etag) {
  throw new Error("Local snapshot MD5 does not match the R2 single-part ETag.")
}
const plan = {
  externalOperationsPerformed: false,
  generatedSql: {
    credentialScrub: createCredentialScrubSql(),
  },
  migrationState: sql.migration,
  nextAuthorizedSteps: [
    "Create the named isolated empty D1 and verify its ID differs from production.",
    "Import the validated raw SQL snapshot into only that isolated D1.",
    "Apply repository migrations forward from the restored d1_migrations ledger.",
    "Run credentialScrub against the isolated D1, then validate all credentials and audit rows are absent.",
    "Regenerate Ed25519 and RS256 JWKS in the isolated environment and run authentication smoke tests.",
    "Write database_restore_completed only after validation; switching the production binding requires separate authorization.",
  ],
  snapshot: {
    createdAt: descriptor.createdAt,
    exportBookmark: descriptor.exportBookmark,
    key: descriptor.key,
    rawBytes: sql.rawBytes,
    sourceRevision: descriptor.revision.id,
    sqlSha256: sql.sha256,
  },
  status: "validated-local-plan-only",
  target,
} as const

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)

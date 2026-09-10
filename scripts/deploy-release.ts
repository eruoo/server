import { spawnSync } from "node:child_process"
import { readFile, appendFile } from "node:fs/promises"
import path from "node:path"

import { verifyBackupLifecycle } from "./lib/backup-lifecycle"
import { prepareMigrationReceipt } from "./lib/migration-receipt"
import { verifyArtifact } from "./lib/release-artifact"
const [directory, environment, sha, runId] = process.argv.slice(2)
if (
  !directory ||
  !sha ||
  !["staging", "production"].includes(environment ?? "") ||
  !runId
)
  throw new Error("Expected artifact directory, environment, SHA and CI run ID")
const manifest = await verifyArtifact(directory, sha, environment!, runId)
if (manifest.repository !== process.env.GITHUB_REPOSITORY)
  throw new Error("Artifact repository mismatch")
if (process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Deployment must use the protected main workflow")
if (
  environment === "production" &&
  (process.env.GITHUB_ACTOR_ID !== "50254496" ||
    process.env.GITHUB_TRIGGERING_ACTOR !== process.env.GITHUB_ACTOR)
)
  throw new Error("Production deployment requires the owner, including reruns")
const configPath = path.resolve(directory, manifest.config)
const config = JSON.parse(await readFile(configPath, "utf8"))
const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID
if (
  !token ||
  !account ||
  !/^[0-9a-f]{32}$/.test(account) ||
  config.vars.CF_ACCOUNT_ID !== account
)
  throw new Error("Missing or mismatched Cloudflare account configuration")
const expectedName = `eruoo-server-${environment}`
const resourceSuffix = environment === "production" ? "" : "-staging"
const expectedBucketName = `eruoo-server-backups${resourceSuffix}`
const expectedWorkflowName = `eruoo-database-backup${resourceSuffix}`
const expectedOrigin =
  environment === "production"
    ? "https://auth.eruoo.me"
    : "https://eruoo-server-staging.l709937065.workers.dev"
if (
  config.name !== expectedName ||
  config.vars.APP_ORIGIN !== expectedOrigin ||
  config.vars.RELEASE_SHA !== sha
)
  throw new Error("Worker name, origin or source mismatch")
const database = config.d1_databases?.find(
  (value: { binding: string }) => value.binding === "DB",
)
const bucket = config.r2_buckets?.find(
  (value: { binding: string }) => value.binding === "BACKUPS",
)
if (
  !database ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    database.database_id,
  ) ||
  database.database_id !== config.vars.D1_DATABASE_ID ||
  !bucket ||
  bucket.bucket_name !== expectedBucketName
)
  throw new Error(
    "Configure the isolated D1 and backup bucket before deploying",
  )
if (
  config.assets?.binding !== "ASSETS" ||
  !config.workflows?.some(
    (value: { binding: string }) =>
      value.binding === "DATABASE_BACKUP_WORKFLOW",
  ) ||
  !config.ratelimits?.some(
    (value: { name: string }) => value.name === "AUTH_RATE_LIMITER",
  ) ||
  !config.ratelimits?.some(
    (value: { name: string }) => value.name === "API_KEY_RATE_LIMITER",
  )
)
  throw new Error("Release bindings are incomplete")
for (const [name, limit] of [
  ["AUTH_RATE_LIMITER", 10],
  ["API_KEY_RATE_LIMITER", 5],
] as const)
  if (
    !config.ratelimits.some(
      (value: { name: string; simple?: { limit: number; period: number } }) =>
        value.name === name &&
        value.simple?.limit === limit &&
        value.simple.period === 60,
    )
  )
    throw new Error("Release rate limiter differs")
if (
  !config.workflows.some(
    (value: { name: string; binding: string; class_name: string }) =>
      value.name === expectedWorkflowName &&
      value.binding === "DATABASE_BACKUP_WORKFLOW" &&
      value.class_name === "DatabaseBackupWorkflow",
  )
)
  throw new Error("Release workflow identity differs")
const crons = ["0 19 * * *", "0 20 * * *"]
if (JSON.stringify([...config.triggers.crons].sort()) !== JSON.stringify(crons))
  throw new Error("Release cron mismatch")
async function cloudflare<T>(suffix: string, init?: RequestInit): Promise<T> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`,
    {
      ...init,
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    },
  )
  if (!response.ok)
    throw new Error(`Cloudflare read or operation failed (${response.status})`)
  const data = (await response.json()) as { success: boolean; result: T }
  if (!data.success) throw new Error("Cloudflare operation did not succeed")
  return data.result
}
type Binding = {
  name: string
  type: string
  text?: string
  id?: string
  bucket_name?: string
  workflow_name?: string
  simple?: { limit: number; period: number }
}
const scriptPath = `workers/scripts/${expectedName}`
const [
  remoteDatabase,
  remoteBucket,
  previous,
  lifecycle,
  managedDomain,
  customDomains,
] = await Promise.all([
  cloudflare<{ uuid: string; name: string }>(
    `d1/database/${database.database_id}`,
  ),
  cloudflare<{ name: string }>(`r2/buckets/${bucket.bucket_name}`),
  cloudflare<{ bindings: Binding[] }>(`${scriptPath}/settings`),
  cloudflare<unknown>(`r2/buckets/${bucket.bucket_name}/lifecycle`),
  cloudflare<{ enabled: boolean }>(
    `r2/buckets/${bucket.bucket_name}/domains/managed`,
  ),
  cloudflare<{ domains: { enabled: boolean }[] }>(
    `r2/buckets/${bucket.bucket_name}/domains/custom`,
  ),
])
if (
  remoteDatabase.uuid !== database.database_id ||
  remoteDatabase.name !== database.database_name ||
  remoteBucket.name !== bucket.bucket_name
)
  throw new Error("Remote resource identity mismatch")
if (
  managedDomain.enabled !== false ||
  !Array.isArray(customDomains.domains) ||
  customDomains.domains.some((domain) => domain.enabled !== false)
)
  throw new Error("Backup bucket public access must be disabled")
verifyBackupLifecycle(lifecycle)
const requiredSecrets: string[] = config.secrets?.required ?? []
if (
  requiredSecrets.length !== 5 ||
  requiredSecrets.some(
    (name) =>
      !previous.bindings.some(
        (binding) => binding.type === "secret_text" && binding.name === name,
      ),
  )
)
  throw new Error("Required Worker secrets are not provisioned")
const currentMigrations: Record<string, string> = JSON.parse(
  config.vars.RELEASE_MIGRATIONS,
)
const priorMigrationsText = previous.bindings.find(
  (binding) => binding.name === "RELEASE_MIGRATIONS",
)?.text
const priorMigrations: Record<string, string> = priorMigrationsText
  ? JSON.parse(priorMigrationsText)
  : {}
for (const [name, hash] of Object.entries(priorMigrations))
  if (currentMigrations[name] !== hash)
    throw new Error("A previously deployed migration was changed or removed")
const existingTables = await cloudflare<{ results: { name: string }[] }[]>(
  `d1/database/${database.database_id}/query`,
  {
    method: "POST",
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    }),
  },
)
const names = existingTables[0]?.results.map((value) => value.name) ?? []
let ledger: string[] = []
if (names.includes("d1_migrations")) {
  const query = await cloudflare<{ results: { name: string }[] }[]>(
    `d1/database/${database.database_id}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        sql: "SELECT name FROM d1_migrations ORDER BY id",
      }),
    },
  )
  ledger = query[0]!.results.map((value) => value.name)
}
const migrations = Object.keys(currentMigrations).sort()
const installed = JSON.parse(
  await readFile(
    path.join(directory, "node_modules/wrangler/package.json"),
    "utf8",
  ),
)
if (installed.version !== manifest.wrangler)
  throw new Error("Deployment toolchain mismatch")
const cliPath = path.join(directory, "node_modules/wrangler/bin/wrangler.js")
function runWrangler(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cliPath, ...args, "--config", configPath],
    { stdio: "inherit", env: { ...process.env, CI: "true" } },
  )
  if (result.status !== 0)
    throw new Error("Remote write failed; stop and inspect before retrying")
}
await prepareMigrationReceipt({
  databaseId: database.database_id,
  migrations: currentMigrations,
  priorMigrations,
  hasPriorDeployment:
    Boolean(priorMigrationsText) &&
    previous.bindings.some(
      (binding) => binding.name === "DB" && binding.id === database.database_id,
    ),
  tables: names,
  ledger,
  query: async (sql, params) => {
    const result = await cloudflare<{ results: Record<string, unknown>[] }[]>(
      `d1/database/${database.database_id}/query`,
      { method: "POST", body: JSON.stringify({ sql, params }) },
    )
    if (!result[0]?.results) throw new Error("Missing D1 query result")
    return result[0].results
  },
})
if (ledger.length < migrations.length)
  runWrangler(["d1", "migrations", "apply", "DB", "--remote"])
runWrangler(["deploy"])
const [settings, schedules, deployments] = await Promise.all([
  cloudflare<{ bindings: Binding[] }>(`${scriptPath}/settings`),
  cloudflare<{ schedules: { cron: string }[] }>(`${scriptPath}/schedules`),
  cloudflare<{
    deployments: {
      id: string
      versions: { version_id: string; percentage: number }[]
    }[]
  }>(`${scriptPath}/deployments`),
])
if (
  !settings.bindings.some(
    (value) => value.name === "DB" && value.id === database.database_id,
  ) ||
  !settings.bindings.some(
    (value) =>
      value.name === "BACKUPS" && value.bucket_name === bucket.bucket_name,
  ) ||
  !settings.bindings.some(
    (value) => value.name === "RELEASE_SHA" && value.text === sha,
  )
)
  throw new Error("Deployed binding or source verification failed")
if (
  !settings.bindings.some(
    (value) =>
      value.name === "DATABASE_BACKUP_WORKFLOW" &&
      value.workflow_name === expectedWorkflowName,
  ) ||
  !settings.bindings.some(
    (value) => value.name === "ASSETS" && value.type === "assets",
  ) ||
  !settings.bindings.some(
    (value) => value.name === "APP_ORIGIN" && value.text === expectedOrigin,
  ) ||
  requiredSecrets.some(
    (name) =>
      !settings.bindings.some(
        (value) => value.name === name && value.type === "secret_text",
      ),
  )
)
  throw new Error("Deployed assets, workflow, origin or secret names differ")
for (const [name, limit] of [
  ["AUTH_RATE_LIMITER", 10],
  ["API_KEY_RATE_LIMITER", 5],
] as const)
  if (
    !settings.bindings.some(
      (value) =>
        value.name === name &&
        value.simple?.limit === limit &&
        value.simple.period === 60,
    )
  )
    throw new Error("Deployed rate limiter differs")
if (
  JSON.stringify(schedules.schedules.map((value) => value.cron).sort()) !==
  JSON.stringify(crons)
)
  throw new Error("Deployed cron verification failed")
const expectedVersion = deployments.deployments[0]?.versions.find(
  (version) => version.percentage === 100,
)?.version_id
if (!expectedVersion) throw new Error("Missing fully deployed Worker version")
const previousVersions = new Set(
  deployments.deployments
    .slice(1)
    .flatMap((deployment) =>
      deployment.versions.map((version) => version.version_id),
    ),
)
const smokeDeadline = Date.now() + 60_000
let observedHealthVersion = "unavailable"
let propagationReported = false
function checkSmokeBudget() {
  const remaining = smokeDeadline - Date.now()
  if (remaining <= 0)
    throw new Error(
      `Smoke test exceeded total budget: expected=${expectedVersion} observed=${observedHealthVersion}`,
    )
  return remaining
}
const probes = [
  ["/health", 200],
  ["/api/auth/get-session", 200],
  ["/api/status", 401],
  ["/api/openapi.json", 401],
  ["/api/unknown-release-probe", 404],
] as const
for (const [route, expected] of probes) {
  while (true) {
    const response = await fetch(expectedOrigin + route, {
      signal: AbortSignal.timeout(Math.min(10_000, checkSmokeBudget())),
      redirect: "manual",
      headers: { accept: "application/json" },
    })
    if (response.status !== expected)
      throw new Error(`Smoke test failed: ${route} status=${response.status}`)
    const body: unknown = await response.json().catch(() => {
      throw new Error(
        `Smoke test failed: ${route} status=${response.status} unreadable JSON`,
      )
    })
    checkSmokeBudget()
    if (route === "/health") {
      const version =
        typeof body === "object" && body !== null && "version" in body
          ? body.version
          : undefined
      observedHealthVersion =
        typeof version === "string" &&
        (version === expectedVersion || previousVersions.has(version))
          ? version
          : "unknown"
      if (version !== expectedVersion) {
        if (typeof version !== "string" || !previousVersions.has(version))
          throw new Error(
            `Smoke test failed: ${route} status=${response.status} expected=${expectedVersion} observed=${observedHealthVersion}`,
          )
        if (!propagationReported) {
          console.log(
            `Waiting for Worker propagation: expected=${expectedVersion} observed=${observedHealthVersion}`,
          )
          propagationReported = true
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1_000, checkSmokeBudget())),
        )
        continue
      }
    }
    if (route === "/api/auth/get-session" && body !== null)
      throw new Error(`Smoke test failed: ${route} status=${response.status}`)
    break
  }
}
const summary = `Deployed ${sha} to ${environment}.\nCI run: ${runId}\nDeployment: ${deployments.deployments[0]?.id}\nMigrations: ${migrations.length - ledger.length} applied\nSmoke: ${probes.length} passed\n`
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
console.log(summary)

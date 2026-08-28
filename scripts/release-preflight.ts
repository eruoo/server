import { readFile } from "node:fs/promises"

import { unstable_readConfig } from "wrangler"
import { z } from "zod"

import { OWNER_GITHUB_ID } from "../src/shared/security"
import {
  DAILY_CLEANUP_SCHEDULE,
  DATABASE_BACKUP_SCHEDULE,
} from "../src/worker/schedules"
import { productionDeployCommands } from "./deploy-production"
import {
  validateReleaseBindingIdentity,
  validateReleaseVersionIdentity,
} from "./release-preflight-validation"

const productionOrigin = "https://auth.eruoo.me"
const productionWorkerName = "eruoo-server-production"
const expectedDeployProductionScript = "tsx scripts/deploy-production.ts"
const expectedReleasePreflightScript =
  "pnpm run openapi:check && pnpm run build && tsx scripts/release-preflight.ts && pnpm run bundle:check && pnpm run startup:check"
const expectedDeployProductionCommands = [
  "pnpm run release:preflight",
  "pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc",
  "pnpm exec wrangler deploy --config dist/eruoo_server/wrangler.json --no-x-provision --strict",
]
const requiredRunWorkerFirst = [
  "/api",
  "/api/*",
  "/problems/*",
  "/.well-known/*",
]

const generatedConfigSchema = z.object({
  assets: z.object({
    not_found_handling: z.literal("single-page-application"),
    run_worker_first: z.array(z.string()),
  }),
  d1_databases: z.array(
    z.object({
      binding: z.string(),
      database_id: z.string().optional(),
    }),
  ),
  name: z.string(),
  preview_urls: z.boolean(),
  ratelimits: z.array(
    z.object({
      name: z.string(),
      namespace_id: z.string(),
      simple: z.object({
        limit: z.number().int().positive(),
        period: z.number().int().positive(),
      }),
    }),
  ),
  r2_buckets: z.array(
    z.object({
      binding: z.string(),
      bucket_name: z.string(),
    }),
  ),
  routes: z.array(
    z.object({
      custom_domain: z.boolean().optional(),
      pattern: z.string(),
    }),
  ),
  secrets: z.object({ required: z.array(z.string()) }),
  targetEnvironment: z.string().optional(),
  triggers: z.object({
    crons: z.array(z.string()),
  }),
  vars: z.record(z.string(), z.unknown()),
  version_metadata: z
    .object({
      binding: z.string(),
    })
    .optional(),
  workflows: z.array(
    z.object({
      binding: z.string(),
      class_name: z.string(),
      name: z.string(),
      schedules: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  ),
  workers_dev: z.boolean(),
})

const failures: string[] = []

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message)
}

function hasExactEntries(
  actual: readonly string[] | string | boolean | undefined,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((entry, index) => actual[index] === entry)
  )
}

const sourceConfig = unstable_readConfig(
  { config: "wrangler.jsonc", env: "production" },
  { hideWarnings: true },
)
const packageManifest = z
  .object({
    scripts: z.object({
      "deploy:production": z.string(),
      "release:preflight": z.string(),
    }),
    version: z.string().min(1),
  })
  .parse(JSON.parse(await readFile("package.json", "utf8")))
const openApiDocument = z
  .object({ info: z.object({ version: z.string().min(1) }) })
  .parse(JSON.parse(await readFile("docs/openapi.json", "utf8")))
const changelog = await readFile("CHANGELOG.md", "utf8")
const defaultEnvironmentConfig = unstable_readConfig(
  { config: "wrangler.jsonc" },
  { hideWarnings: true },
)
const generatedConfig = generatedConfigSchema.parse(
  JSON.parse(await readFile("dist/eruoo_server/wrangler.json", "utf8")),
)
const sourceDatabase = sourceConfig.d1_databases.find(
  (database: { binding: string }) => database.binding === "DB",
)
const generatedDatabase = generatedConfig.d1_databases.find(
  ({ binding }) => binding === "DB",
)
const sourceBackupBucket = sourceConfig.r2_buckets.find(
  (bucket: { binding: string }) => bucket.binding === "BACKUPS",
)
const generatedBackupBucket = generatedConfig.r2_buckets.find(
  ({ binding }) => binding === "BACKUPS",
)
const sourceBackupWorkflow = sourceConfig.workflows.find(
  (workflow: { binding: string }) =>
    workflow.binding === "DATABASE_BACKUP_WORKFLOW",
)
const defaultBackupWorkflow = defaultEnvironmentConfig.workflows.find(
  (workflow: { binding: string }) =>
    workflow.binding === "DATABASE_BACKUP_WORKFLOW",
)
const generatedBackupWorkflow = generatedConfig.workflows.find(
  ({ binding }) => binding === "DATABASE_BACKUP_WORKFLOW",
)
const sourceAuthRateLimiter = sourceConfig.ratelimits?.find(
  (rateLimit: { name: string }) => rateLimit.name === "AUTH_RATE_LIMITER",
)
const generatedAuthRateLimiter = generatedConfig.ratelimits.find(
  ({ name }) => name === "AUTH_RATE_LIMITER",
)
const sourceVars = sourceConfig.vars
const configuredSecrets = (sourceConfig.secrets?.required ?? []).filter(
  (secret: unknown): secret is string => typeof secret === "string",
)

check(
  packageManifest.scripts["release:preflight"] ===
    expectedReleasePreflightScript,
  "release:preflight must check OpenAPI drift before building and validating the production artifact.",
)
check(
  packageManifest.scripts["deploy:production"] ===
    expectedDeployProductionScript &&
    productionDeployCommands
      .map((command) => `${command.executable} ${command.args.join(" ")}`)
      .join("\n") === expectedDeployProductionCommands.join("\n"),
  "deploy:production must use the tested preflight, remote migration, generated-config deployment sequence.",
)
failures.push(
  ...validateReleaseVersionIdentity({
    changelog,
    openApiVersion: openApiDocument.info.version,
    packageVersion: packageManifest.version,
  }),
)

check(
  sourceConfig.targetEnvironment === "production",
  "Wrangler must resolve the production environment.",
)
check(
  sourceConfig.name === productionWorkerName &&
    generatedConfig.name === productionWorkerName,
  `Both source and generated configs must target ${productionWorkerName}.`,
)
check(
  sourceConfig.workers_dev === false && generatedConfig.workers_dev === false,
  "workers.dev must remain disabled in production.",
)
check(
  sourceConfig.preview_urls === false && generatedConfig.preview_urls === false,
  "Preview URLs must remain disabled in production.",
)
check(
  sourceConfig.assets?.not_found_handling === "single-page-application" &&
    generatedConfig.assets.not_found_handling === "single-page-application" &&
    hasExactEntries(
      sourceConfig.assets?.run_worker_first,
      requiredRunWorkerFirst,
    ) &&
    hasExactEntries(
      generatedConfig.assets.run_worker_first,
      requiredRunWorkerFirst,
    ),
  "Source and generated assets must preserve the SPA fallback and run all API and well-known routes through the Worker.",
)
check(
  sourceConfig.routes?.some(
    (route: { custom_domain?: boolean; pattern: string } | string) =>
      typeof route === "object" &&
      route.pattern === "auth.eruoo.me" &&
      route.custom_domain === true,
  ) === true &&
    generatedConfig.routes.some(
      (route) =>
        route.pattern === "auth.eruoo.me" && route.custom_domain === true,
    ),
  "The production custom domain must be auth.eruoo.me.",
)
check(
  sourceVars["APP_ENV"] === "production" &&
    generatedConfig.vars["APP_ENV"] === "production",
  "APP_ENV must be production in source and generated configs.",
)
check(
  sourceVars["APP_ORIGIN"] === productionOrigin &&
    generatedConfig.vars["APP_ORIGIN"] === productionOrigin,
  `APP_ORIGIN must be ${productionOrigin}.`,
)
check(
  sourceVars["OWNER_GITHUB_ID"] === OWNER_GITHUB_ID &&
    generatedConfig.vars["OWNER_GITHUB_ID"] === OWNER_GITHUB_ID,
  `OWNER_GITHUB_ID must be the approved owner ${OWNER_GITHUB_ID}.`,
)
check(
  sourceConfig.version_metadata?.binding === "CF_VERSION_METADATA" &&
    generatedConfig.version_metadata?.binding === "CF_VERSION_METADATA",
  "Source and generated production configs must declare CF_VERSION_METADATA.",
)
check(
  sourceConfig.ratelimits?.length === 1 &&
    generatedConfig.ratelimits.length === 1 &&
    sourceAuthRateLimiter?.namespace_id === "1002" &&
    generatedAuthRateLimiter?.namespace_id === "1002" &&
    sourceAuthRateLimiter.simple?.limit === 10 &&
    generatedAuthRateLimiter?.simple.limit === 10 &&
    sourceAuthRateLimiter.simple?.period === 60 &&
    generatedAuthRateLimiter?.simple.period === 60,
  "Production must preserve the 10 requests per 60 seconds AUTH_RATE_LIMITER binding.",
)
check(
  hasExactEntries(defaultEnvironmentConfig.triggers?.crons, []),
  "The default Wrangler environment must resolve without cron triggers.",
)
check(
  hasExactEntries(sourceConfig.triggers?.crons, [DAILY_CLEANUP_SCHEDULE]) &&
    hasExactEntries(generatedConfig.triggers.crons, [DAILY_CLEANUP_SCHEDULE]),
  `Source and generated production configs must schedule daily cleanup with ${DAILY_CLEANUP_SCHEDULE} UTC and no additional cron triggers.`,
)
check(
  sourceBackupBucket?.bucket_name === "eruoo-server-backups" &&
    generatedBackupBucket?.bucket_name === "eruoo-server-backups",
  "The production BACKUPS binding must survive the Vite build and target eruoo-server-backups.",
)
check(
  defaultEnvironmentConfig.workflows.length === 1 &&
    defaultBackupWorkflow?.name === "eruoo-database-backup" &&
    defaultBackupWorkflow.class_name === "DatabaseBackupWorkflow" &&
    defaultBackupWorkflow.schedules === undefined,
  "The default environment must bind the database backup Workflow without scheduling it.",
)
check(
  sourceConfig.workflows.length === 1 &&
    generatedConfig.workflows.length === 1 &&
    sourceBackupWorkflow?.name === "eruoo-database-backup" &&
    generatedBackupWorkflow?.name === "eruoo-database-backup" &&
    sourceBackupWorkflow.class_name === "DatabaseBackupWorkflow" &&
    generatedBackupWorkflow?.class_name === "DatabaseBackupWorkflow" &&
    hasExactEntries(sourceBackupWorkflow.schedules, [
      DATABASE_BACKUP_SCHEDULE,
    ]) &&
    hasExactEntries(generatedBackupWorkflow?.schedules, [
      DATABASE_BACKUP_SCHEDULE,
    ]),
  `Production must schedule only DatabaseBackupWorkflow with ${DATABASE_BACKUP_SCHEDULE} UTC.`,
)
failures.push(
  ...validateReleaseBindingIdentity({
    generatedAccountId: generatedConfig.vars["CF_ACCOUNT_ID"],
    generatedAllowedCorsOrigins: generatedConfig.vars["ALLOWED_CORS_ORIGINS"],
    generatedDatabaseBindingId: generatedDatabase?.database_id,
    generatedDatabaseId: generatedConfig.vars["D1_DATABASE_ID"],
    generatedSecrets: generatedConfig.secrets.required,
    sourceAccountId: sourceVars["CF_ACCOUNT_ID"],
    sourceAllowedCorsOrigins: sourceVars["ALLOWED_CORS_ORIGINS"],
    sourceDatabaseBindingId: sourceDatabase?.database_id,
    sourceDatabaseId: sourceVars["D1_DATABASE_ID"],
    sourceSecrets: configuredSecrets,
  }),
)

if (failures.length > 0) {
  throw new Error(
    `Production release preflight failed:\n${failures
      .map((failure) => `- ${failure}`)
      .join("\n")}`,
  )
}

process.stdout.write("Production release configuration is fail-closed.\n")

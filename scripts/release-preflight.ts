import { readFile } from "node:fs/promises"

import { unstable_readConfig } from "wrangler"
import { z } from "zod"

import {
  API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS,
} from "../src/shared/api-key"
import { OWNER_GITHUB_ID } from "../src/shared/security"
import {
  DAILY_CLEANUP_SCHEDULE,
  DATABASE_BACKUP_SCHEDULE,
} from "../src/worker/schedules"
import {
  productionCloudflareAccountId,
  productionDeployCommands,
} from "./deploy-production"
import {
  readProductionMigrationBaseline,
  readProductionMigrationFileState,
} from "./migration-history"
import {
  hasExactProductionCustomDomainRoute,
  hasNoProductionOutboundTelemetry,
  productionMigrationContract,
  productionCustomDomainRoutesSchema,
  validateProductionMigrationBindingContract,
  validateProductionMigrationChecksums,
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
  "pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc --env-file /dev/null",
  "pnpm exec wrangler deploy --config dist/eruoo_server/wrangler.json --env-file /dev/null --no-x-provision --strict",
]
const requiredRunWorkerFirst = [
  "/api",
  "/api/*",
  "/problems/*",
  "/.well-known/*",
]

const generatedConfigSchema = z.object({
  account_id: z.string(),
  assets: z
    .object({
      directory: z.literal("../client"),
      not_found_handling: z.literal("single-page-application"),
      run_worker_first: z.array(z.string()),
    })
    .strict(),
  d1_databases: z.array(
    z
      .object({
        binding: z.string(),
        database_id: z.string().optional(),
        database_name: z.string(),
        migrations_dir: z.string(),
        migrations_pattern: z.string(),
        migrations_table: z.string(),
        remote: z.boolean(),
      })
      .strict(),
  ),
  logpush: z.boolean().nullable().optional(),
  name: z.string(),
  observability: z
    .object({
      enabled: z.boolean(),
      logs: z
        .object({
          destinations: z.array(z.unknown()).nullable().optional(),
          enabled: z.boolean(),
          head_sampling_rate: z.number(),
          invocation_logs: z.boolean(),
        })
        .strict(),
      traces: z
        .object({
          destinations: z.array(z.unknown()).nullable().optional(),
          enabled: z.boolean(),
          head_sampling_rate: z.number(),
          propagation_policy: z.unknown().optional(),
        })
        .strict(),
    })
    .strict(),
  preview_urls: z.boolean(),
  ratelimits: z.array(
    z
      .object({
        name: z.string(),
        namespace_id: z.string(),
        simple: z
          .object({
            limit: z.number().int().positive(),
            period: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  ),
  r2_buckets: z.array(
    z
      .object({
        binding: z.string(),
        bucket_name: z.string(),
        remote: z.boolean(),
      })
      .strict(),
  ),
  routes: productionCustomDomainRoutesSchema,
  secrets: z.object({ required: z.array(z.string()) }).strict(),
  streaming_tail_consumers: z.tuple([]),
  tail_consumers: z.array(z.unknown()).nullable().optional(),
  targetEnvironment: z.string().optional(),
  triggers: z
    .object({
      crons: z.array(z.string()),
    })
    .strict(),
  vars: z
    .object({
      ALLOWED_CORS_ORIGINS: z.unknown(),
      APP_ENV: z.unknown(),
      APP_ORIGIN: z.unknown(),
      CF_ACCOUNT_ID: z.unknown(),
      D1_DATABASE_ID: z.unknown(),
      OWNER_GITHUB_ID: z.unknown(),
    })
    .strict(),
  version_metadata: z
    .object({
      binding: z.string(),
    })
    .optional(),
  workflows: z.array(
    z
      .object({
        binding: z.string(),
        class_name: z.string(),
        name: z.string(),
        schedules: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict(),
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
const sourceDatabase = sourceConfig.d1_databases.find(
  (database: { binding: string }) => database.binding === "DB",
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
const generatedConfigValue: unknown = JSON.parse(
  await readFile("dist/eruoo_server/wrangler.json", "utf8"),
)
const generatedConfig = generatedConfigSchema.parse(generatedConfigValue)
const generatedDatabase = generatedConfig.d1_databases.find(
  ({ binding }) => binding === "DB",
)
const migrationBindingFailures = validateProductionMigrationBindingContract({
  generatedBindingCount: generatedConfig.d1_databases.length,
  generatedDirectory: generatedDatabase?.migrations_dir,
  generatedPattern: generatedDatabase?.migrations_pattern,
  generatedTable: generatedDatabase?.migrations_table,
  sourceBindingCount: sourceConfig.d1_databases.length,
  sourceDirectory: sourceDatabase?.migrations_dir,
  sourcePattern: sourceDatabase?.migrations_pattern,
  sourceTable: sourceDatabase?.migrations_table,
})
const sourceMigrationDirectory =
  migrationBindingFailures.length === 0 &&
  typeof sourceDatabase?.migrations_dir === "string"
    ? sourceDatabase.migrations_dir
    : productionMigrationContract.sourceDirectory
const productionMigrationBaseline = readProductionMigrationBaseline({
  migrationDirectory: sourceMigrationDirectory,
})
if (productionMigrationBaseline.kind === "unavailable") {
  console.warn(productionMigrationBaseline.warning)
}
const productionMigrationFileState = readProductionMigrationFileState({
  migrationDirectory: sourceMigrationDirectory,
})
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
const sourceApiKeyRateLimiter = sourceConfig.ratelimits?.find(
  (rateLimit: { name: string }) => rateLimit.name === "API_KEY_RATE_LIMITER",
)
const generatedApiKeyRateLimiter = generatedConfig.ratelimits.find(
  ({ name }) => name === "API_KEY_RATE_LIMITER",
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
  ...migrationBindingFailures,
  ...productionMigrationFileState.failures,
  ...validateProductionMigrationChecksums({
    actualChecksums: productionMigrationFileState.checksums,
    baselineChecksums: productionMigrationBaseline.checksums,
  }),
)

check(
  sourceConfig.targetEnvironment === "production" &&
    generatedConfig.targetEnvironment === "production",
  "Source and generated Wrangler configs must resolve the production environment.",
)
check(
  sourceDatabase?.database_name === "eruoo-server" &&
    sourceDatabase.remote === false &&
    generatedDatabase?.database_name === "eruoo-server" &&
    generatedDatabase.remote === false,
  "The sole production DB binding must target eruoo-server without remote local-development access.",
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
  hasExactProductionCustomDomainRoute(sourceConfig.routes) &&
    hasExactProductionCustomDomainRoute(
      typeof generatedConfigValue === "object" &&
        generatedConfigValue !== null &&
        "routes" in generatedConfigValue
        ? generatedConfigValue.routes
        : undefined,
    ),
  "Source and generated production routes must contain only the auth.eruoo.me custom domain.",
)
check(
  hasNoProductionOutboundTelemetry({
    logpush: sourceConfig.logpush,
    observability: sourceConfig.observability,
    streamingTailConsumers: sourceConfig.streaming_tail_consumers,
    tailConsumers: sourceConfig.tail_consumers,
  }) &&
    hasNoProductionOutboundTelemetry({
      logpush: generatedConfig.logpush,
      observability: generatedConfig.observability,
      streamingTailConsumers: generatedConfig.streaming_tail_consumers,
      tailConsumers: generatedConfig.tail_consumers,
    }),
  "Source and generated production configs must not export logs, traces, or tail events.",
)
check(
  Array.isArray(sourceConfig.streaming_tail_consumers) &&
    sourceConfig.streaming_tail_consumers.length === 0 &&
    generatedConfig.streaming_tail_consumers.length === 0,
  "Source and generated production configs must explicitly clear Streaming Tail consumers.",
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
  sourceConfig.ratelimits?.length === 2 &&
    generatedConfig.ratelimits.length === 2 &&
    sourceAuthRateLimiter?.namespace_id === "1002" &&
    generatedAuthRateLimiter?.namespace_id === "1002" &&
    sourceAuthRateLimiter.simple?.limit === 10 &&
    generatedAuthRateLimiter?.simple.limit === 10 &&
    sourceAuthRateLimiter.simple?.period === 60 &&
    generatedAuthRateLimiter?.simple.period === 60 &&
    sourceApiKeyRateLimiter?.namespace_id === "1004" &&
    generatedApiKeyRateLimiter?.namespace_id === "1004" &&
    sourceApiKeyRateLimiter.simple?.limit ===
      API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS &&
    generatedApiKeyRateLimiter?.simple.limit ===
      API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS &&
    sourceApiKeyRateLimiter.simple?.period ===
      API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS &&
    generatedApiKeyRateLimiter?.simple.period ===
      API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS,
  `Production must preserve the AUTH_RATE_LIMITER 10/60 and API_KEY_RATE_LIMITER ${API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS}/${API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS} bindings.`,
)
check(
  hasExactEntries(defaultEnvironmentConfig.triggers?.crons, []),
  "The default Wrangler environment must resolve without cron triggers.",
)
check(
  hasExactEntries(sourceConfig.triggers?.crons, [
    DAILY_CLEANUP_SCHEDULE,
    DATABASE_BACKUP_SCHEDULE,
  ]) &&
    hasExactEntries(generatedConfig.triggers.crons, [
      DAILY_CLEANUP_SCHEDULE,
      DATABASE_BACKUP_SCHEDULE,
    ]),
  `Source and generated production configs must schedule cleanup with ${DAILY_CLEANUP_SCHEDULE} UTC and backup dispatch with ${DATABASE_BACKUP_SCHEDULE} UTC as the only Worker cron triggers.`,
)
check(
  sourceConfig.r2_buckets.length === 1 &&
    generatedConfig.r2_buckets.length === 1 &&
    sourceBackupBucket?.bucket_name === "eruoo-server-backups" &&
    sourceBackupBucket.remote === false &&
    generatedBackupBucket?.bucket_name === "eruoo-server-backups" &&
    generatedBackupBucket.remote === false,
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
    sourceBackupWorkflow.schedules === undefined &&
    generatedBackupWorkflow?.schedules === undefined,
  "Production must bind DatabaseBackupWorkflow without a paid direct Workflow schedule.",
)
failures.push(
  ...validateReleaseBindingIdentity({
    deploymentAccountId: productionCloudflareAccountId,
    generatedConfigAccountId: generatedConfig.account_id,
    generatedRuntimeAccountId: generatedConfig.vars["CF_ACCOUNT_ID"],
    generatedAllowedCorsOrigins: generatedConfig.vars["ALLOWED_CORS_ORIGINS"],
    generatedDatabaseBindingId: generatedDatabase?.database_id,
    generatedDatabaseId: generatedConfig.vars["D1_DATABASE_ID"],
    generatedSecrets: generatedConfig.secrets.required,
    sourceConfigAccountId: sourceConfig.account_id,
    sourceRuntimeAccountId: sourceVars["CF_ACCOUNT_ID"],
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

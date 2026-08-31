import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import {
  hasNoProductionOutboundTelemetry,
  productionCustomDomainRoutesSchema,
  requiredProductionSecrets,
} from "./release-preflight-validation"

const productionWorkerName = "eruoo-server-production"
const productionCloudflareApiBaseUrl = "https://api.cloudflare.com/client/v4"
const generatedProductionConfigPath = "dist/eruoo_server/wrangler.json"
const productionWorkerEnvironment = "production"
const productionWorkerCustomDomain = "auth.eruoo.me"
const safeWranglerEnvironmentFile = "/dev/null"
const bootstrapVersionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const commitShaPattern = /^[0-9a-f]{40}$/u
const accountIdPattern = /^[0-9a-f]{32}$/u
const wranglerInspectionTimeoutMs = 30_000
const cloudflareApiTimeoutMs = 30_000
const postconditionAttempts = 5
const postconditionRetryDelayMs = 2_000

export function createProductionWorkerBootstrapApiUrl(apiPath: string): string {
  return `${productionCloudflareApiBaseUrl}${apiPath}`
}

const secretSchema = z
  .object({
    name: z.string(),
    type: z.literal("secret_text"),
  })
  .loose()

const activeDeploymentSchema = z
  .object({
    annotations: z.record(z.string(), z.string()).optional(),
    id: z.string().regex(bootstrapVersionIdPattern),
    source: z.string(),
    strategy: z.literal("percentage"),
    versions: z.tuple([
      z
        .object({
          percentage: z.literal(100),
          version_id: z.string().regex(bootstrapVersionIdPattern),
        })
        .loose(),
    ]),
  })
  .loose()

const deployedVersionSchema = z
  .object({
    annotations: z.record(z.string(), z.string()).optional(),
    id: z.string().regex(bootstrapVersionIdPattern),
    metadata: z.object({ source: z.string() }).loose(),
    resources: z
      .object({
        bindings: z.array(
          z.object({ name: z.string(), type: z.string() }).loose(),
        ),
        script: z
          .object({
            handlers: z.array(z.string()),
            last_deployed_from: z.string(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose()

const generatedConfigSchema = z
  .object({
    account_id: z.string().regex(accountIdPattern),
    d1_databases: z.array(
      z
        .object({
          binding: z.string(),
          database_id: z.string(),
        })
        .loose(),
    ),
    name: z.literal(productionWorkerName),
    r2_buckets: z.array(
      z
        .object({
          binding: z.string(),
          bucket_name: z.string(),
        })
        .loose(),
    ),
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
        .loose(),
    ),
    routes: productionCustomDomainRoutesSchema,
    secrets: z.object({ required: z.array(z.string()) }).loose(),
    streaming_tail_consumers: z.tuple([]),
    vars: z.record(z.string(), z.string()),
    version_metadata: z.object({ binding: z.string() }).loose(),
    workflows: z.array(
      z
        .object({
          binding: z.string(),
          class_name: z.string(),
          name: z.string(),
          schedules: z.array(z.string()),
        })
        .loose(),
    ),
  })
  .loose()

const customDomainChangesetResponseSchema = z
  .object({
    result: z.object({
      added: z.array(z.object({ hostname: z.string() }).loose()),
      conflicting: z.array(z.unknown()),
      removed: z.array(z.unknown()),
      updated: z.array(z.unknown()),
    }),
    success: z.literal(true),
  })
  .loose()

const customDomainsResponseSchema = z
  .object({
    result: z.array(
      z
        .object({
          environment: z.string().optional(),
          hostname: z.string(),
          service: z.string().optional(),
        })
        .loose(),
    ),
    success: z.literal(true),
  })
  .loose()

const scriptSettingsResponseSchema = z
  .object({
    result: z
      .object({
        logpush: z.boolean().nullable().optional(),
        observability: z.unknown(),
        streaming_tail_consumers: z.array(z.unknown()).nullable().optional(),
        tail_consumers: z.array(z.unknown()).nullable().optional(),
      })
      .loose(),
    success: z.literal(true),
  })
  .loose()

type GeneratedConfig = z.infer<typeof generatedConfigSchema>
type BindingContract = Record<string, unknown> & {
  name: string
  type: string
}

export interface ProductionWorkerBootstrapCommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface ProductionWorkerBootstrapApiResult {
  body: unknown
  status: number
}

export interface ProductionWorkerBootstrapApiRequest {
  body?: unknown
  method?: "GET" | "POST"
}

export interface ProductionWorkerBootstrapIdentity {
  commitSha: string
  message: string
  tag: string
  templateVersionId: string
}

export interface ProductionWorkerBootstrapInspector {
  readCloudflareApi: (
    path: string,
    request?: ProductionWorkerBootstrapApiRequest,
  ) => Promise<ProductionWorkerBootstrapApiResult>
  readGeneratedConfig: () => Promise<unknown>
  runWrangler: (
    args: readonly string[],
  ) => Promise<ProductionWorkerBootstrapCommandResult>
  wait: (milliseconds: number) => Promise<void>
}

function hasExactUniqueEntries(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual)
  return (
    actual.length === expected.length &&
    actualSet.size === actual.length &&
    expected.every((entry) => actualSet.has(entry))
  )
}

function parseJson(output: string, resource: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(
      `Production Worker bootstrap verification failed because ${resource} returned invalid JSON.`,
    )
  }
}

function expectedBindingContract(
  generatedConfig: GeneratedConfig,
): BindingContract[] {
  return [
    ...Object.entries(generatedConfig.vars).map(([name, text]) => ({
      name,
      text,
      type: "plain_text",
    })),
    ...generatedConfig.secrets.required.map((name) => ({
      name,
      type: "secret_text",
    })),
    ...generatedConfig.d1_databases.map(({ binding: name, database_id }) => ({
      database_id,
      name,
      type: "d1",
    })),
    ...generatedConfig.r2_buckets.map(({ binding: name, bucket_name }) => ({
      bucket_name,
      name,
      type: "r2_bucket",
    })),
    ...generatedConfig.workflows.map(
      ({ binding: name, class_name, name: workflow_name }) => ({
        class_name,
        name,
        script_name: productionWorkerName,
        type: "workflow",
        workflow_name,
      }),
    ),
    ...generatedConfig.ratelimits.map(({ name, namespace_id, simple }) => ({
      name,
      namespace_id,
      simple,
      type: "ratelimit",
    })),
    {
      name: generatedConfig.version_metadata.binding,
      type: "version_metadata",
    },
  ]
}

function hasExactBindingContract(
  actual: readonly BindingContract[],
  expected: readonly BindingContract[],
): boolean {
  const secretNames = new Set<string>(requiredProductionSecrets)
  const normalizedActual = actual.map((binding) => {
    if (
      binding.type === "d1" &&
      binding["database_id"] === undefined &&
      typeof binding["id"] === "string"
    ) {
      return { ...binding, database_id: binding["id"] }
    }
    if (binding.type === "workflow" && binding["script_name"] === undefined) {
      return { ...binding, script_name: productionWorkerName }
    }
    if (secretNames.has(binding.name)) {
      return binding.type === "secret_text" ||
        (binding.type === "inherit" && binding["old_name"] === undefined)
        ? { name: binding.name, type: "secret_text" }
        : binding
    }
    return binding
  })
  const actualNames = normalizedActual.map(({ name }) => name)
  const expectedNames = expected.map(({ name }) => name)
  if (
    !hasExactUniqueEntries(actualNames, expectedNames) ||
    new Set(expectedNames).size !== expectedNames.length
  ) {
    return false
  }

  const actualByName = new Map(
    normalizedActual.map((binding) => [binding.name, binding]),
  )
  return expected.every((expectedBinding) => {
    const actualBinding = actualByName.get(expectedBinding.name)
    return (
      actualBinding !== undefined &&
      Object.entries(expectedBinding).every(([key, value]) =>
        isDeepStrictEqual(actualBinding[key], value),
      )
    )
  })
}

function hasApprovedGeneratedCore(generatedConfig: GeneratedConfig): boolean {
  const expectedBindingNames = expectedBindingContract(generatedConfig).map(
    ({ name }) => name,
  )
  return (
    generatedConfig.account_id === generatedConfig.vars["CF_ACCOUNT_ID"] &&
    hasExactUniqueEntries(
      generatedConfig.secrets.required,
      requiredProductionSecrets,
    ) &&
    generatedConfig.d1_databases.length === 1 &&
    generatedConfig.d1_databases[0]?.binding === "DB" &&
    generatedConfig.r2_buckets.length === 1 &&
    generatedConfig.r2_buckets[0]?.binding === "BACKUPS" &&
    generatedConfig.ratelimits.length === 1 &&
    generatedConfig.ratelimits[0]?.name === "AUTH_RATE_LIMITER" &&
    generatedConfig.workflows.length === 1 &&
    generatedConfig.workflows[0]?.binding === "DATABASE_BACKUP_WORKFLOW" &&
    generatedConfig.workflows[0]?.class_name === "DatabaseBackupWorkflow" &&
    generatedConfig.workflows[0]?.name === "eruoo-database-backup" &&
    hasExactUniqueEntries(generatedConfig.workflows[0]?.schedules ?? [], [
      "0 19 * * 6",
    ]) &&
    generatedConfig.version_metadata.binding === "CF_VERSION_METADATA" &&
    new Set(expectedBindingNames).size === expectedBindingNames.length
  )
}

export function createProductionWorkerBootstrapWranglerEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  if (source["WRANGLER_LOG_PATH"] !== undefined) {
    throw new Error(
      "Production Worker bootstrap forbids WRANGLER_LOG_PATH for inspection commands.",
    )
  }
  if (source["CF_API_BASE_URL"] !== undefined) {
    throw new Error(
      "Production Worker bootstrap forbids the deprecated CF_API_BASE_URL override for inspection commands.",
    )
  }
  const cloudflareApiToken = source["CLOUDFLARE_API_TOKEN"]
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(environment)) delete environment[name]
  for (const [name, value] of Object.entries(source)) {
    const canonicalName = name.toUpperCase()
    if (
      canonicalName.startsWith("CLOUDFLARE_") ||
      canonicalName.startsWith("CF_") ||
      canonicalName.startsWith("WRANGLER_")
    ) {
      continue
    }
    environment[name] = value
  }
  if (cloudflareApiToken !== undefined) {
    environment["CLOUDFLARE_API_TOKEN"] = cloudflareApiToken
  }
  environment["CLOUDFLARE_COMPLIANCE_REGION"] = "public"
  environment["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] = "false"
  environment["NO_COLOR"] = "1"
  environment["WRANGLER_API_ENVIRONMENT"] = "production"
  environment["WRANGLER_CI_GENERATE_PREVIEW_ALIAS"] = "false"
  environment["WRANGLER_CI_OVERRIDE_NAME"] = productionWorkerName
  environment["WRANGLER_LOG_SANITIZE"] = "true"
  environment["WRANGLER_WRITE_LOGS"] = "false"
  return environment
}

export function readProductionWorkerBootstrapApiToken(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const token = source["CLOUDFLARE_API_TOKEN"]
  if (token === undefined || token.trim().length === 0) {
    throw new Error(
      "Production Worker bootstrap requires CLOUDFLARE_API_TOKEN for Cloudflare API inspection.",
    )
  }
  return token
}

export function createProductionWorkerBootstrapWranglerArguments(
  args: readonly string[],
): string[] {
  if (
    args.some(
      (argument) =>
        argument === "--env-file" ||
        argument.startsWith("--env-file=") ||
        argument === "--config" ||
        argument.startsWith("--config=") ||
        argument === "-c",
    )
  ) {
    throw new Error(
      "Production Worker bootstrap inspection commands may not override the pinned Wrangler config or safe environment file.",
    )
  }
  return [
    "exec",
    "wrangler",
    ...args,
    "--config",
    generatedProductionConfigPath,
    "--env-file",
    safeWranglerEnvironmentFile,
  ]
}

async function runWrangler(
  args: readonly string[],
): Promise<ProductionWorkerBootstrapCommandResult> {
  const result = spawnSync(
    "pnpm",
    createProductionWorkerBootstrapWranglerArguments(args),
    {
      encoding: "utf8",
      env: createProductionWorkerBootstrapWranglerEnvironment(),
      shell: false,
      timeout: wranglerInspectionTimeoutMs,
    },
  )
  if (result.error) {
    throw new Error(
      "Production Worker bootstrap could not start a required Wrangler inspection command.",
    )
  }
  return {
    exitCode: result.status ?? -1,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  }
}

function createDefaultInspector(): ProductionWorkerBootstrapInspector {
  return {
    readCloudflareApi: async (apiPath, request = {}) => {
      const token = readProductionWorkerBootstrapApiToken()
      let response: Response
      try {
        response = await fetch(createProductionWorkerBootstrapApiUrl(apiPath), {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          method: request.method ?? "GET",
          signal: AbortSignal.timeout(cloudflareApiTimeoutMs),
          ...(request.body === undefined
            ? {}
            : { body: JSON.stringify(request.body) }),
        })
      } catch {
        throw new Error(
          "Production Worker bootstrap could not complete the required Custom Domain inspection.",
        )
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error(
          "Production Worker bootstrap received an invalid Custom Domain API response.",
        )
      }
      return { body, status: response.status }
    },
    readGeneratedConfig: async () =>
      JSON.parse(await readFile(generatedProductionConfigPath, "utf8")),
    runWrangler,
    wait: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
      }),
  }
}

const defaultInspector = createDefaultInspector()

async function inspectJson(
  inspector: ProductionWorkerBootstrapInspector,
  resource: string,
  args: readonly string[],
): Promise<unknown> {
  const result = await inspector.runWrangler(args)
  if (result.exitCode !== 0) {
    throw new Error(
      `Production Worker bootstrap could not inspect ${resource}.`,
    )
  }
  return parseJson(result.stdout, resource)
}

async function readGeneratedConfig(
  inspector: ProductionWorkerBootstrapInspector,
): Promise<GeneratedConfig> {
  let value: unknown
  try {
    value = await inspector.readGeneratedConfig()
  } catch {
    throw new Error(
      "Production Worker bootstrap verification failed because the generated production config could not be read.",
    )
  }
  const parsed = generatedConfigSchema.safeParse(value)
  if (!parsed.success || !hasApprovedGeneratedCore(parsed.data)) {
    throw new Error(
      "Production Worker bootstrap verification failed because the generated production config does not declare the approved core identity and bindings.",
    )
  }
  return parsed.data
}

async function readSecrets(
  inspector: ProductionWorkerBootstrapInspector,
): Promise<z.infer<typeof secretSchema>[]> {
  const value = await inspectJson(inspector, "the Secret listing", [
    "secret",
    "list",
    "--name",
    productionWorkerName,
    "--format",
    "json",
  ])
  const parsed = z.array(secretSchema).safeParse(value)
  if (
    !parsed.success ||
    !hasExactUniqueEntries(
      parsed.data.map(({ name }) => name),
      requiredProductionSecrets,
    )
  ) {
    throw new Error(
      "Production Worker bootstrap verification failed because the remote Secret manifest is not the exact required set.",
    )
  }
  return parsed.data
}

async function assertCustomDomainCanBeAdded(
  generatedConfig: GeneratedConfig,
  inspector: ProductionWorkerBootstrapInspector,
): Promise<void> {
  const path = `/accounts/${generatedConfig.account_id}/workers/scripts/${productionWorkerName}/domains/changeset?replace_state=true`
  let response: ProductionWorkerBootstrapApiResult
  try {
    response = await inspector.readCloudflareApi(path, {
      body: [{ hostname: productionWorkerCustomDomain }],
      method: "POST",
    })
  } catch {
    throw new Error(
      "Production Worker bootstrap could not verify the Custom Domain changeset.",
    )
  }
  const parsed = customDomainChangesetResponseSchema.safeParse(response.body)
  if (
    response.status !== 200 ||
    !parsed.success ||
    parsed.data.result.added.length !== 1 ||
    parsed.data.result.added[0]?.hostname !== productionWorkerCustomDomain ||
    parsed.data.result.conflicting.length !== 0 ||
    parsed.data.result.removed.length !== 0 ||
    parsed.data.result.updated.length !== 0
  ) {
    throw new Error(
      "Production Worker bootstrap precondition failed because the Custom Domain would not be added without conflict.",
    )
  }
}

async function assertCustomDomainIsActive(
  generatedConfig: GeneratedConfig,
  inspector: ProductionWorkerBootstrapInspector,
): Promise<void> {
  const path = `/accounts/${generatedConfig.account_id}/workers/domains?service=${productionWorkerName}&environment=${productionWorkerEnvironment}`
  let response: ProductionWorkerBootstrapApiResult
  try {
    response = await inspector.readCloudflareApi(path)
  } catch {
    throw new Error(
      "Production Worker bootstrap could not verify the active Custom Domain.",
    )
  }
  const parsed = customDomainsResponseSchema.safeParse(response.body)
  const domain = parsed.success ? parsed.data.result[0] : undefined
  if (
    response.status !== 200 ||
    !parsed.success ||
    parsed.data.result.length !== 1 ||
    domain?.hostname !== productionWorkerCustomDomain ||
    domain.service !== productionWorkerName ||
    (domain.environment !== undefined &&
      domain.environment !== productionWorkerEnvironment)
  ) {
    throw new Error(
      "Production Worker bootstrap postcondition failed because the target Custom Domain is not attached to the production Worker.",
    )
  }
}

async function assertNoRemoteOutboundTelemetry(
  generatedConfig: GeneratedConfig,
  inspector: ProductionWorkerBootstrapInspector,
): Promise<void> {
  const path = `/accounts/${generatedConfig.account_id}/workers/scripts/${productionWorkerName}/script-settings`
  let response: ProductionWorkerBootstrapApiResult
  try {
    response = await inspector.readCloudflareApi(path)
  } catch {
    throw new Error(
      "Production Worker bootstrap could not verify remote outbound telemetry settings.",
    )
  }
  const parsed = scriptSettingsResponseSchema.safeParse(response.body)
  if (
    response.status !== 200 ||
    !parsed.success ||
    !hasNoProductionOutboundTelemetry({
      logpush: parsed.data.result.logpush,
      observability: parsed.data.result.observability,
      streamingTailConsumers: parsed.data.result.streaming_tail_consumers,
      tailConsumers: parsed.data.result.tail_consumers,
    })
  ) {
    throw new Error(
      "Production Worker bootstrap postcondition failed because remote outbound telemetry remains configured.",
    )
  }
}

export function parseProductionWorkerBootstrapVersionId(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  if (!bootstrapVersionIdPattern.test(value)) {
    throw new Error(
      "Production deployment requires a lowercase UUID in PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID when one-time bootstrap mode is requested.",
    )
  }
  return value
}

export function createProductionWorkerBootstrapIdentity(
  templateVersionId: string,
  commitSha: string,
  createAttemptId: () => string = randomUUID,
): ProductionWorkerBootstrapIdentity {
  const parsedTemplateVersionId =
    parseProductionWorkerBootstrapVersionId(templateVersionId)
  const normalizedCommitSha = commitSha.toLowerCase()
  const attemptId = createAttemptId()
  if (
    !parsedTemplateVersionId ||
    !commitShaPattern.test(normalizedCommitSha) ||
    !bootstrapVersionIdPattern.test(attemptId)
  ) {
    throw new Error(
      "Production Worker bootstrap identity requires a pinned template version, a full commit SHA, and a lowercase UUID attempt ID.",
    )
  }
  const tag = `bootstrap-${normalizedCommitSha.slice(0, 12)}-${attemptId}`
  return {
    commitSha: normalizedCommitSha,
    message: `eruoo-server production bootstrap ${normalizedCommitSha} ${tag}`,
    tag,
    templateVersionId: parsedTemplateVersionId,
  }
}

function assertProductionWorkerBootstrapIdentity(
  identity: ProductionWorkerBootstrapIdentity,
): void {
  const expected = createProductionWorkerBootstrapIdentity(
    identity.templateVersionId,
    identity.commitSha,
    () => identity.tag.slice(-36),
  )
  if (identity.tag !== expected.tag || identity.message !== expected.message) {
    throw new Error(
      "Production Worker bootstrap postcondition received an invalid deployment identity.",
    )
  }
}

export async function assertProductionWorkerBootstrapPrecondition(
  expectedVersionId: string,
  inspector: ProductionWorkerBootstrapInspector = defaultInspector,
): Promise<void> {
  const bootstrapVersionId =
    parseProductionWorkerBootstrapVersionId(expectedVersionId)
  if (!bootstrapVersionId) {
    throw new Error(
      "Production Worker bootstrap precondition failed without a pinned template version.",
    )
  }
  const generatedConfig = await readGeneratedConfig(inspector)
  const deploymentValue = await inspectJson(
    inspector,
    "the active deployment",
    ["deployments", "status", "--name", productionWorkerName, "--json"],
  )
  const deployment = activeDeploymentSchema.safeParse(deploymentValue)
  if (
    !deployment.success ||
    deployment.data.source !== "dash_template" ||
    deployment.data.versions[0].version_id !== bootstrapVersionId
  ) {
    throw new Error(
      "Production Worker bootstrap precondition failed because the pinned Dashboard template is not the sole active version.",
    )
  }
  await readSecrets(inspector)
  await assertCustomDomainCanBeAdded(generatedConfig, inspector)
}

async function assertProductionWorkerBootstrapPostconditionOnce(
  identity: ProductionWorkerBootstrapIdentity,
  generatedConfig: GeneratedConfig,
  inspector: ProductionWorkerBootstrapInspector,
): Promise<void> {
  const deploymentValue = await inspectJson(
    inspector,
    "the active post-deploy deployment",
    ["deployments", "status", "--name", productionWorkerName, "--json"],
  )
  const deployment = activeDeploymentSchema.safeParse(deploymentValue)
  if (
    !deployment.success ||
    deployment.data.source !== "wrangler" ||
    deployment.data.annotations?.["workers/message"] !== identity.message ||
    deployment.data.versions[0].version_id === identity.templateVersionId
  ) {
    throw new Error(
      "Production Worker bootstrap postcondition failed because this deployment attempt is not active.",
    )
  }
  const deployedVersionId = deployment.data.versions[0].version_id
  const versionValue = await inspectJson(
    inspector,
    "the active post-deploy version",
    [
      "versions",
      "view",
      deployedVersionId,
      "--name",
      productionWorkerName,
      "--json",
    ],
  )
  const version = deployedVersionSchema.safeParse(versionValue)
  if (
    !version.success ||
    version.data.id !== deployedVersionId ||
    version.data.metadata.source !== "wrangler" ||
    version.data.annotations?.["workers/tag"] !== identity.tag ||
    version.data.annotations?.["workers/message"] !== identity.message ||
    version.data.resources.script.last_deployed_from !== "wrangler" ||
    !hasExactUniqueEntries(version.data.resources.script.handlers, [
      "fetch",
      "scheduled",
    ]) ||
    !hasExactBindingContract(
      version.data.resources.bindings,
      expectedBindingContract(generatedConfig),
    )
  ) {
    throw new Error(
      "Production Worker bootstrap postcondition failed because the active version does not match this attempt and the generated core binding contract.",
    )
  }
  await readSecrets(inspector)
  await assertCustomDomainIsActive(generatedConfig, inspector)
  await assertNoRemoteOutboundTelemetry(generatedConfig, inspector)
}

export async function assertProductionWorkerBootstrapPostcondition(
  identity: ProductionWorkerBootstrapIdentity,
  inspector: ProductionWorkerBootstrapInspector = defaultInspector,
): Promise<void> {
  assertProductionWorkerBootstrapIdentity(identity)
  const generatedConfig = await readGeneratedConfig(inspector)
  let lastFailure: unknown
  for (let attempt = 1; attempt <= postconditionAttempts; attempt += 1) {
    try {
      await assertProductionWorkerBootstrapPostconditionOnce(
        identity,
        generatedConfig,
        inspector,
      )
      return
    } catch (error) {
      lastFailure = error
      if (attempt < postconditionAttempts) {
        await inspector.wait(postconditionRetryDelayMs)
      }
    }
  }
  const lastFailureMessage =
    lastFailure instanceof Error &&
    lastFailure.message.startsWith("Production Worker bootstrap ")
      ? ` Last verification failure: ${lastFailure.message}`
      : ""
  throw new Error(
    `Production Worker bootstrap postcondition did not converge. The deployment may already be live or partially applied; no rollback was attempted and an automatic retry is forbidden.${lastFailureMessage}`,
    { cause: lastFailure },
  )
}

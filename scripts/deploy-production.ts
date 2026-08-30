import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  assertProductionWorkerBootstrapPostcondition,
  assertProductionWorkerBootstrapPrecondition,
  createProductionWorkerBootstrapIdentity,
  parseProductionWorkerBootstrapVersionId,
  type ProductionWorkerBootstrapIdentity,
} from "./production-worker-bootstrap"

export interface ProductionDeployCommand {
  args: readonly string[]
  childEnvironment: "cloudflare" | "preflight"
  executable: "pnpm"
}

export const productionDeployCommands = [
  {
    args: ["run", "release:preflight"],
    childEnvironment: "preflight",
    executable: "pnpm",
  },
  {
    args: [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      "--env",
      "production",
      "--config",
      "wrangler.jsonc",
      "--env-file",
      "/dev/null",
    ],
    childEnvironment: "cloudflare",
    executable: "pnpm",
  },
  {
    args: [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      "dist/eruoo_server/wrangler.json",
      "--env-file",
      "/dev/null",
      "--no-x-provision",
      "--strict",
    ],
    childEnvironment: "cloudflare",
    executable: "pnpm",
  },
] as const satisfies readonly ProductionDeployCommand[]

export function createProductionBootstrapDeployCommands(
  identity: ProductionWorkerBootstrapIdentity,
): readonly ProductionDeployCommand[] {
  return [
    productionDeployCommands[0],
    productionDeployCommands[1],
    {
      args: [
        ...productionDeployCommands[2].args.filter(
          (argument) => argument !== "--strict",
        ),
        "--tag",
        identity.tag,
        "--message",
        identity.message,
      ],
      childEnvironment: "cloudflare",
      executable: "pnpm",
    },
  ]
}

export interface ProductionDeployContext {
  bootstrapVersionId: string | undefined
  branch: string | undefined
  checkedOutCommitSha: string
  cloudflareApiTokenPresent: boolean
  commitSha: string | undefined
  productionBranchCommitSha: string
  workersCi: string | undefined
  worktreeStatus: string | undefined
}

export interface ProductionDeployEnvironment {
  CF_ACCOUNT_ID?: string | undefined
  CF_API_BASE_URL?: string | undefined
  CLOUDFLARE_ACCOUNT_ID?: string | undefined
  CLOUDFLARE_API_BASE_URL?: string | undefined
  CLOUDFLARE_API_TOKEN?: string | undefined
  CLOUDFLARE_COMPLIANCE_REGION?: string | undefined
  PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID?: string | undefined
  WRANGLER_API_ENVIRONMENT?: string | undefined
  WRANGLER_AUTH_DOMAIN?: string | undefined
  WRANGLER_AUTH_URL?: string | undefined
  WRANGLER_CI_GENERATE_PREVIEW_ALIAS?: string | undefined
  WRANGLER_CI_MATCH_TAG?: string | undefined
  WRANGLER_CI_OVERRIDE_NAME?: string | undefined
  WRANGLER_LOG_PATH?: string | undefined
  WRANGLER_REVOKE_URL?: string | undefined
  WRANGLER_TOKEN_URL?: string | undefined
  WRANGLER_WRITE_LOGS?: string | undefined
  WORKERS_CI: string | undefined
  WORKERS_CI_BRANCH: string | undefined
  WORKERS_CI_COMMIT_SHA: string | undefined
}

export type ProductionDeployRunner = (
  command: ProductionDeployCommand,
) => Promise<void>
export type ProductionDeployContextResolver = () => ProductionDeployContext
export type ProductionDeployGitReader = (
  args: readonly string[],
) => string | undefined

export interface ProductionDeployDependencies {
  createBootstrapIdentity: (
    templateVersionId: string,
    commitSha: string,
  ) => ProductionWorkerBootstrapIdentity
  resolveContext: ProductionDeployContextResolver
  runner: ProductionDeployRunner
  verifyBootstrapPostcondition: (
    identity: ProductionWorkerBootstrapIdentity,
  ) => Promise<void>
  verifyBootstrapPrecondition: (templateVersionId: string) => Promise<void>
}

const gitCommitShaPattern = /^[0-9a-f]{40}$/u
const gitCommandTimeoutMs = 10_000
const productionBranch = "production"
const productionBranchRef = `refs/heads/${productionBranch}`
const productionRepositoryUrl = "https://github.com/eruoo/server.git"
const productionWorkerName = "eruoo-server-production"
export const productionCloudflareAccountId = "1d204c847b5870d3438dc79534b91798"
const productionRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)

const forbiddenRuntimeOverrides = [
  "CF_API_BASE_URL",
  "CLOUDFLARE_API_BASE_URL",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_LOG_PATH",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_TOKEN_URL",
] as const satisfies readonly (keyof ProductionDeployEnvironment)[]

const exactRuntimeOverrides = {
  CF_ACCOUNT_ID: productionCloudflareAccountId,
  CLOUDFLARE_ACCOUNT_ID: productionCloudflareAccountId,
  CLOUDFLARE_COMPLIANCE_REGION: "public",
  WRANGLER_API_ENVIRONMENT: "production",
  WRANGLER_CI_GENERATE_PREVIEW_ALIAS: "false",
  WRANGLER_CI_OVERRIDE_NAME: productionWorkerName,
  WRANGLER_WRITE_LOGS: "false",
} as const satisfies Partial<Record<keyof ProductionDeployEnvironment, string>>

function currentProductionEnvironment(): ProductionDeployEnvironment {
  return {
    CF_ACCOUNT_ID: process.env["CF_ACCOUNT_ID"],
    CF_API_BASE_URL: process.env["CF_API_BASE_URL"],
    CLOUDFLARE_ACCOUNT_ID: process.env["CLOUDFLARE_ACCOUNT_ID"],
    CLOUDFLARE_API_BASE_URL: process.env["CLOUDFLARE_API_BASE_URL"],
    CLOUDFLARE_API_TOKEN: process.env["CLOUDFLARE_API_TOKEN"],
    CLOUDFLARE_COMPLIANCE_REGION: process.env["CLOUDFLARE_COMPLIANCE_REGION"],
    PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID:
      process.env["PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID"],
    WRANGLER_API_ENVIRONMENT: process.env["WRANGLER_API_ENVIRONMENT"],
    WRANGLER_AUTH_DOMAIN: process.env["WRANGLER_AUTH_DOMAIN"],
    WRANGLER_AUTH_URL: process.env["WRANGLER_AUTH_URL"],
    WRANGLER_CI_GENERATE_PREVIEW_ALIAS:
      process.env["WRANGLER_CI_GENERATE_PREVIEW_ALIAS"],
    WRANGLER_CI_MATCH_TAG: process.env["WRANGLER_CI_MATCH_TAG"],
    WRANGLER_CI_OVERRIDE_NAME: process.env["WRANGLER_CI_OVERRIDE_NAME"],
    WRANGLER_LOG_PATH: process.env["WRANGLER_LOG_PATH"],
    WRANGLER_REVOKE_URL: process.env["WRANGLER_REVOKE_URL"],
    WRANGLER_TOKEN_URL: process.env["WRANGLER_TOKEN_URL"],
    WRANGLER_WRITE_LOGS: process.env["WRANGLER_WRITE_LOGS"],
    WORKERS_CI: process.env["WORKERS_CI"],
    WORKERS_CI_BRANCH: process.env["WORKERS_CI_BRANCH"],
    WORKERS_CI_COMMIT_SHA: process.env["WORKERS_CI_COMMIT_SHA"],
  }
}

function assertProductionRuntimeEnvironment(
  environment: ProductionDeployEnvironment,
): void {
  for (const name of forbiddenRuntimeOverrides) {
    if (environment[name] !== undefined) {
      throw new Error(`Production deployment forbids the ${name} override.`)
    }
  }

  for (const [name, expected] of Object.entries(exactRuntimeOverrides)) {
    const actual = environment[name as keyof ProductionDeployEnvironment]
    if (actual !== undefined && actual !== expected) {
      throw new Error(
        `Production deployment rejects ${name} unless it is exactly ${expected}.`,
      )
    }
  }
}

export function createProductionGitChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {}

  for (const [name, value] of Object.entries(source)) {
    const canonicalName = name.toUpperCase()
    if (
      canonicalName.startsWith("GIT_") ||
      canonicalName.startsWith("CLOUDFLARE_") ||
      canonicalName.startsWith("CF_") ||
      canonicalName.startsWith("WRANGLER_")
    ) {
      continue
    }
    environment[name] = value
  }

  environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
  environment["GIT_CONFIG_NOSYSTEM"] = "1"
  environment["GIT_NO_REPLACE_OBJECTS"] = "1"
  environment["GIT_TERMINAL_PROMPT"] = "0"
  return environment as NodeJS.ProcessEnv
}

function readGitOutput(args: readonly string[]): string | undefined {
  const readsRemoteRef = args[0] === "ls-remote"
  const isolatedDirectory = readsRemoteRef
    ? mkdtempSync(path.join(os.tmpdir(), "eruoo-production-git-"))
    : undefined

  try {
    const environment = createProductionGitChildEnvironment()
    if (isolatedDirectory) {
      environment["GIT_CEILING_DIRECTORIES"] = isolatedDirectory
    }

    return execFileSync(
      "git",
      readsRemoteRef ? [...args] : ["-C", productionRepositoryRoot, ...args],
      {
        cwd: isolatedDirectory ?? productionRepositoryRoot,
        encoding: "utf8",
        env: environment,
        timeout: gitCommandTimeoutMs,
      },
    ).trim()
  } catch {
    return undefined
  } finally {
    if (isolatedDirectory) {
      rmSync(isolatedDirectory, { force: true, recursive: true })
    }
  }
}

function resolveProductionBranchCommitSha(
  readOutput: ProductionDeployGitReader,
): string {
  const output =
    readOutput([
      "ls-remote",
      "--exit-code",
      productionRepositoryUrl,
      productionBranchRef,
    ]) ?? ""
  const [commitSha, ref, extra] = output.split(/\s+/u)
  return !extra && ref === productionBranchRef ? (commitSha ?? "") : ""
}

export function resolveProductionDeployContext(
  environment: ProductionDeployEnvironment = currentProductionEnvironment(),
  readOutput: ProductionDeployGitReader = readGitOutput,
): ProductionDeployContext {
  assertProductionRuntimeEnvironment(environment)

  return {
    bootstrapVersionId: parseProductionWorkerBootstrapVersionId(
      environment.PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID,
    ),
    branch: environment.WORKERS_CI_BRANCH,
    checkedOutCommitSha: readOutput(["rev-parse", "--verify", "HEAD"]) ?? "",
    cloudflareApiTokenPresent:
      environment.CLOUDFLARE_API_TOKEN !== undefined &&
      environment.CLOUDFLARE_API_TOKEN.trim().length > 0,
    commitSha: environment.WORKERS_CI_COMMIT_SHA,
    productionBranchCommitSha: resolveProductionBranchCommitSha(readOutput),
    workersCi: environment.WORKERS_CI,
    worktreeStatus: readOutput([
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  }
}

export function assertProductionDeployContext(
  context: ProductionDeployContext,
): void {
  if (context.workersCi !== "1") {
    throw new Error(
      "Production deployment is restricted to Cloudflare Workers Builds.",
    )
  }
  if (context.branch !== productionBranch) {
    throw new Error(
      `Production deployment requires WORKERS_CI_BRANCH=${productionBranch}.`,
    )
  }

  const injectedCommitSha = context.commitSha?.toLowerCase() ?? ""
  const checkedOutCommitSha = context.checkedOutCommitSha.toLowerCase()
  const productionBranchCommitSha =
    context.productionBranchCommitSha.toLowerCase()
  if (!gitCommitShaPattern.test(injectedCommitSha)) {
    throw new Error(
      "Production deployment requires a valid WORKERS_CI_COMMIT_SHA.",
    )
  }
  if (!gitCommitShaPattern.test(checkedOutCommitSha)) {
    throw new Error(
      "Production deployment could not verify the checked-out Git commit.",
    )
  }
  if (injectedCommitSha !== checkedOutCommitSha) {
    throw new Error(
      "WORKERS_CI_COMMIT_SHA does not match the checked-out Git commit.",
    )
  }
  if (!gitCommitShaPattern.test(productionBranchCommitSha)) {
    throw new Error(
      "Production deployment could not resolve the protected remote production branch.",
    )
  }
  if (productionBranchCommitSha !== checkedOutCommitSha) {
    throw new Error(
      "The checked-out Git commit does not match the protected remote production branch.",
    )
  }
  if (context.worktreeStatus === undefined) {
    throw new Error(
      "Production deployment could not verify the Git worktree state.",
    )
  }
  if (context.worktreeStatus !== "") {
    throw new Error("Production deployment requires a clean Git worktree.")
  }
  if (!context.cloudflareApiTokenPresent) {
    throw new Error(
      "Production deployment requires a non-empty CLOUDFLARE_API_TOKEN and forbids fallback to Wrangler disk credentials.",
    )
  }
}

function createProductionScrubbedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment = createProductionGitChildEnvironment(source)
  environment["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"] = "false"
  environment["WRANGLER_API_ENVIRONMENT"] = "production"
  environment["WRANGLER_CI_GENERATE_PREVIEW_ALIAS"] = "false"
  environment["WRANGLER_CI_OVERRIDE_NAME"] = productionWorkerName
  environment["WRANGLER_LOG_SANITIZE"] = "true"
  environment["WRANGLER_WRITE_LOGS"] = "false"
  return environment
}

export function createProductionPreflightChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return createProductionScrubbedEnvironment(source)
}

export function createProductionDeployChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const token = source["CLOUDFLARE_API_TOKEN"]
  if (token === undefined || token.trim().length === 0) {
    throw new Error(
      "Production deployment requires a non-empty CLOUDFLARE_API_TOKEN and forbids fallback to Wrangler disk credentials.",
    )
  }

  const environment = createProductionScrubbedEnvironment(source)
  environment["CLOUDFLARE_API_TOKEN"] = token
  environment["CLOUDFLARE_ACCOUNT_ID"] = productionCloudflareAccountId
  environment["CLOUDFLARE_COMPLIANCE_REGION"] = "public"
  const matchTag = source["WRANGLER_CI_MATCH_TAG"]
  if (matchTag !== undefined) environment["WRANGLER_CI_MATCH_TAG"] = matchTag
  return environment
}

export function createProductionCommandChildEnvironment(
  command: ProductionDeployCommand,
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  return command.childEnvironment === "preflight"
    ? createProductionPreflightChildEnvironment(source)
    : createProductionDeployChildEnvironment(source)
}

function runCommand(
  command: ProductionDeployCommand,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: productionRepositoryRoot,
      env: environment,
      shell: false,
      stdio: "inherit",
    })

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          signal
            ? `Production deployment command terminated by ${signal}.`
            : `Production deployment command exited with ${code ?? "no status"}.`,
        ),
      )
    })
  })
}

function createDefaultRunner(
  source: Readonly<Record<string, string | undefined>> = process.env,
): ProductionDeployRunner {
  const frozenSource = { ...source }
  const preflightEnvironment =
    createProductionPreflightChildEnvironment(frozenSource)
  const cloudflareEnvironment =
    createProductionDeployChildEnvironment(frozenSource)

  return (command) =>
    runCommand(
      command,
      command.childEnvironment === "preflight"
        ? preflightEnvironment
        : cloudflareEnvironment,
    )
}

function postWriteFailure(message: string, failures: readonly unknown[]) {
  return new AggregateError(failures, message)
}

export function formatProductionDeployFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Production deployment failed without a classified error."
  }
  if (!(error instanceof AggregateError)) return error.message

  return [
    error.message,
    ...error.errors.map((failure) =>
      failure instanceof Error
        ? `- ${failure.message}`
        : "- Unclassified production deployment failure.",
    ),
  ].join("\n")
}

export async function runProductionDeploy(
  overrides: Partial<ProductionDeployDependencies> = {},
): Promise<void> {
  const dependencies: ProductionDeployDependencies = {
    createBootstrapIdentity:
      overrides.createBootstrapIdentity ??
      createProductionWorkerBootstrapIdentity,
    resolveContext: overrides.resolveContext ?? resolveProductionDeployContext,
    runner: overrides.runner ?? createDefaultRunner(),
    verifyBootstrapPostcondition:
      overrides.verifyBootstrapPostcondition ??
      assertProductionWorkerBootstrapPostcondition,
    verifyBootstrapPrecondition:
      overrides.verifyBootstrapPrecondition ??
      assertProductionWorkerBootstrapPrecondition,
  }

  const initialContext = dependencies.resolveContext()
  assertProductionDeployContext(initialContext)
  const bootstrapVersionId = initialContext.bootstrapVersionId
  const assertCurrentContext = (): ProductionDeployContext => {
    const context = dependencies.resolveContext()
    assertProductionDeployContext(context)
    if (context.bootstrapVersionId !== bootstrapVersionId) {
      throw new Error(
        "Production Worker bootstrap mode changed during deployment.",
      )
    }
    return context
  }

  const bootstrapIdentity = bootstrapVersionId
    ? dependencies.createBootstrapIdentity(
        bootstrapVersionId,
        initialContext.checkedOutCommitSha,
      )
    : undefined
  const commands = bootstrapIdentity
    ? createProductionBootstrapDeployCommands(bootstrapIdentity)
    : productionDeployCommands

  await dependencies.runner(commands[0])

  if (bootstrapVersionId) {
    assertCurrentContext()
    await dependencies.verifyBootstrapPrecondition(bootstrapVersionId)
  }

  assertCurrentContext()
  try {
    await dependencies.runner(commands[1])
  } catch (error) {
    throw postWriteFailure(
      "Production D1 migration was attempted and failed. The remote schema may already be partially applied; automatic retry is forbidden.",
      [error],
    )
  }

  try {
    assertCurrentContext()
    if (bootstrapVersionId) {
      await dependencies.verifyBootstrapPrecondition(bootstrapVersionId)
      assertCurrentContext()
    }
  } catch (error) {
    throw postWriteFailure(
      "Production deployment stopped after D1 migration. The remote schema may already be applied; automatic retry is forbidden.",
      [error],
    )
  }

  const failures: unknown[] = []
  try {
    await dependencies.runner(commands[2])
  } catch (error) {
    failures.push(error)
  }

  if (bootstrapIdentity) {
    try {
      await dependencies.verifyBootstrapPostcondition(bootstrapIdentity)
    } catch (error) {
      failures.push(error)
    }
  }

  try {
    assertCurrentContext()
  } catch (error) {
    failures.push(error)
  }

  if (failures.length > 0) {
    throw postWriteFailure(
      "Production Worker upload was attempted. Remote Worker state may already be applied; automatic retry is forbidden.",
      failures,
    )
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runProductionDeploy()
  } catch (error) {
    console.error(formatProductionDeployFailure(error))
    process.exitCode = 1
  }
}

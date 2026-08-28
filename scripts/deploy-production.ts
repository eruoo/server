import { execFileSync, spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"

export interface ProductionDeployCommand {
  args: readonly string[]
  executable: "pnpm"
}

export const productionDeployCommands = [
  {
    args: ["run", "release:preflight"],
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
    ],
    executable: "pnpm",
  },
  {
    args: [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      "dist/eruoo_server/wrangler.json",
      "--no-x-provision",
      "--strict",
    ],
    executable: "pnpm",
  },
] as const satisfies readonly ProductionDeployCommand[]

export type ProductionDeployRunner = (
  command: ProductionDeployCommand,
) => Promise<void>

export interface ProductionDeployContext {
  branch: string | undefined
  checkedOutCommitSha: string
  commitSha: string | undefined
  productionBranchCommitSha: string
  worktreeStatus: string | undefined
  workersCi: string | undefined
}

export interface ProductionDeployEnvironment {
  WORKERS_CI: string | undefined
  WORKERS_CI_BRANCH: string | undefined
  WORKERS_CI_COMMIT_SHA: string | undefined
}

export type ProductionDeployContextResolver = () => ProductionDeployContext
export type ProductionDeployGitReader = (
  args: readonly string[],
) => string | undefined

const gitCommitShaPattern = /^[0-9a-f]{40}$/
const gitCommandTimeoutMs = 10_000
const productionBranch = "production"
const productionBranchRef = `refs/heads/${productionBranch}`
const productionRepositoryUrl = "https://github.com/eruoo/server.git"

function readGitOutput(args: readonly string[]): string | undefined {
  try {
    return execFileSync("git", [...args], {
      encoding: "utf8",
      timeout: gitCommandTimeoutMs,
    }).trim()
  } catch {
    return undefined
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

function assertProductionDeployEnvironment(
  context: Pick<ProductionDeployContext, "branch" | "commitSha" | "workersCi">,
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

  if (!gitCommitShaPattern.test(context.commitSha?.toLowerCase() ?? "")) {
    throw new Error(
      "Production deployment requires a valid WORKERS_CI_COMMIT_SHA.",
    )
  }
}

export function resolveProductionDeployContext(
  environment: ProductionDeployEnvironment = {
    WORKERS_CI: process.env["WORKERS_CI"],
    WORKERS_CI_BRANCH: process.env["WORKERS_CI_BRANCH"],
    WORKERS_CI_COMMIT_SHA: process.env["WORKERS_CI_COMMIT_SHA"],
  },
  readOutput: ProductionDeployGitReader = readGitOutput,
): ProductionDeployContext {
  const branch = environment.WORKERS_CI_BRANCH
  const commitSha = environment.WORKERS_CI_COMMIT_SHA
  const workersCi = environment.WORKERS_CI

  assertProductionDeployEnvironment({ branch, commitSha, workersCi })

  return {
    branch,
    checkedOutCommitSha: readOutput(["rev-parse", "--verify", "HEAD"]) ?? "",
    commitSha,
    productionBranchCommitSha: resolveProductionBranchCommitSha(readOutput),
    worktreeStatus: readOutput([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    workersCi,
  }
}

export function assertProductionDeployContext(
  context: ProductionDeployContext,
): void {
  assertProductionDeployEnvironment(context)

  const commitSha = context.commitSha?.toLowerCase() ?? ""
  const checkedOutCommitSha = context.checkedOutCommitSha.toLowerCase()
  const productionBranchCommitSha =
    context.productionBranchCommitSha.toLowerCase()

  if (!gitCommitShaPattern.test(checkedOutCommitSha)) {
    throw new Error(
      "Production deployment could not verify the checked-out Git commit.",
    )
  }

  if (commitSha !== checkedOutCommitSha) {
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
}

function runCommand(command: ProductionDeployCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
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

export async function runProductionDeploy(
  runner: ProductionDeployRunner = runCommand,
  resolveContext: ProductionDeployContextResolver = resolveProductionDeployContext,
): Promise<void> {
  for (const command of productionDeployCommands) {
    assertProductionDeployContext(resolveContext())
    await runner(command)
  }

  assertProductionDeployContext(resolveContext())
}

const invokedPath = process.argv[1]
if (
  invokedPath &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runProductionDeploy()
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Production deployment failed without a classified error.",
    )
    process.exitCode = 1
  }
}

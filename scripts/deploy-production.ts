import { spawn } from "node:child_process"
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
): Promise<void> {
  for (const command of productionDeployCommands) {
    await runner(command)
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
    console.error(
      error instanceof Error
        ? error.message
        : "Production deployment failed without a classified error.",
    )
    process.exitCode = 1
  }
}

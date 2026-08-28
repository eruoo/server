import { describe, expect, it } from "vitest"

import {
  productionDeployCommands,
  resolveProductionDeployContext,
  runProductionDeploy,
  type ProductionDeployCommand,
  type ProductionDeployContext,
} from "./deploy-production"

function render(command: ProductionDeployCommand): string {
  return [command.executable, ...command.args].join(" ")
}

const expectedCommands = [
  "pnpm run release:preflight",
  "pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc",
  "pnpm exec wrangler deploy --config dist/eruoo_server/wrangler.json --no-x-provision --strict",
]
const checkedOutCommitSha = "a".repeat(40)
const validDeployContext = {
  branch: "production",
  checkedOutCommitSha,
  commitSha: checkedOutCommitSha,
  productionBranchCommitSha: checkedOutCommitSha,
  worktreeStatus: "",
  workersCi: "1",
} satisfies ProductionDeployContext

function resolveValidDeployContext(): ProductionDeployContext {
  return validDeployContext
}

describe("production deployment orchestration", () => {
  it.each([
    {
      environment: {
        WORKERS_CI: undefined,
        WORKERS_CI_BRANCH: undefined,
        WORKERS_CI_COMMIT_SHA: undefined,
      },
      message: "restricted to Cloudflare Workers Builds",
      name: "outside Workers Builds",
    },
    {
      environment: {
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "main",
        WORKERS_CI_COMMIT_SHA: checkedOutCommitSha,
      },
      message: "WORKERS_CI_BRANCH=production",
      name: "from a non-production branch",
    },
    {
      environment: {
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "production",
        WORKERS_CI_COMMIT_SHA: "not-a-commit",
      },
      message: "valid WORKERS_CI_COMMIT_SHA",
      name: "without a valid injected commit",
    },
  ])("rejects $name before reading Git state", ({ environment, message }) => {
    const gitCalls: string[][] = []

    expect(() =>
      resolveProductionDeployContext(environment, (args) => {
        gitCalls.push([...args])
        return ""
      }),
    ).toThrow(message)

    expect(gitCalls).toEqual([])
  })

  it("runs preflight, remote migration, and generated-config deployment in order", async () => {
    const calls: string[] = []

    await runProductionDeploy(async (command) => {
      calls.push(render(command))
    }, resolveValidDeployContext)

    expect(productionDeployCommands.map(render)).toEqual(expectedCommands)
    expect(calls).toEqual(expectedCommands)
  })

  it.each([1, 2, 3])(
    "stops before any command after step %s fails",
    async (failingStep) => {
      const calls: string[] = []

      await expect(
        runProductionDeploy(async (command) => {
          calls.push(render(command))
          if (calls.length === failingStep) {
            throw new Error("synthetic command failure")
          }
        }, resolveValidDeployContext),
      ).rejects.toThrow("synthetic command failure")

      expect(calls).toEqual(expectedCommands.slice(0, failingStep))
    },
  )

  it("revalidates the protected production commit before every step", async () => {
    const calls: string[] = []
    let contextReads = 0

    await expect(
      runProductionDeploy(
        async (command) => {
          calls.push(render(command))
        },
        () => {
          contextReads += 1
          return contextReads === 2
            ? {
                ...validDeployContext,
                productionBranchCommitSha: "b".repeat(40),
              }
            : validDeployContext
        },
      ),
    ).rejects.toThrow("does not match the protected remote production branch")

    expect(calls).toEqual(expectedCommands.slice(0, 1))
    expect(contextReads).toBe(2)
  })

  it("detects a protected branch advance during the final deploy", async () => {
    const calls: string[] = []
    let contextReads = 0

    await expect(
      runProductionDeploy(
        async (command) => {
          calls.push(render(command))
        },
        () => {
          contextReads += 1
          return contextReads === 4
            ? {
                ...validDeployContext,
                productionBranchCommitSha: "b".repeat(40),
              }
            : validDeployContext
        },
      ),
    ).rejects.toThrow("does not match the protected remote production branch")

    expect(calls).toEqual(expectedCommands)
    expect(contextReads).toBe(4)
  })

  it.each([
    {
      context: { ...validDeployContext, workersCi: undefined },
      message: "restricted to Cloudflare Workers Builds",
      name: "outside Workers Builds",
    },
    {
      context: { ...validDeployContext, branch: "main" },
      message: "WORKERS_CI_BRANCH=production",
      name: "from a non-production branch",
    },
    {
      context: { ...validDeployContext, commitSha: undefined },
      message: "valid WORKERS_CI_COMMIT_SHA",
      name: "without an injected commit SHA",
    },
    {
      context: { ...validDeployContext, commitSha: "b".repeat(40) },
      message: "does not match the checked-out Git commit",
      name: "when the injected commit differs from HEAD",
    },
    {
      context: { ...validDeployContext, productionBranchCommitSha: "" },
      message: "resolve the protected remote production branch",
      name: "when the remote production branch cannot be resolved",
    },
    {
      context: {
        ...validDeployContext,
        productionBranchCommitSha: "b".repeat(40),
      },
      message: "does not match the protected remote production branch",
      name: "when HEAD differs from the remote production branch",
    },
    {
      context: { ...validDeployContext, worktreeStatus: undefined },
      message: "could not verify the Git worktree state",
      name: "when the worktree state cannot be read",
    },
    {
      context: { ...validDeployContext, worktreeStatus: " M package.json" },
      message: "requires a clean Git worktree",
      name: "from a dirty worktree",
    },
  ])(
    "rejects $name before running any command",
    async ({ context, message }) => {
      const calls: string[] = []

      await expect(
        runProductionDeploy(
          async (command) => {
            calls.push(render(command))
          },
          () => context,
        ),
      ).rejects.toThrow(message)

      expect(calls).toEqual([])
    },
  )
})

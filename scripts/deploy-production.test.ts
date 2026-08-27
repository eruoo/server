import { describe, expect, it } from "vitest"

import {
  productionDeployCommands,
  runProductionDeploy,
  type ProductionDeployCommand,
} from "./deploy-production"

function render(command: ProductionDeployCommand): string {
  return [command.executable, ...command.args].join(" ")
}

const expectedCommands = [
  "pnpm run release:preflight",
  "pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc",
  "pnpm exec wrangler deploy --config dist/eruoo_server/wrangler.json --no-x-provision --strict",
]

describe("production deployment orchestration", () => {
  it("runs preflight, remote migration, and generated-config deployment in order", async () => {
    const calls: string[] = []

    await runProductionDeploy(async (command) => {
      calls.push(render(command))
    })

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
        }),
      ).rejects.toThrow("synthetic command failure")

      expect(calls).toEqual(expectedCommands.slice(0, failingStep))
    },
  )
})

import { spawnSync } from "node:child_process"
const [environment, sha] = process.argv.slice(2)
if (
  !["staging", "production"].includes(environment ?? "") ||
  !sha ||
  !/^[a-f0-9]{40}$/.test(sha)
)
  throw new Error(
    "Usage: pnpm deploy:staging <full SHA> (or deploy:production)",
  )
const result = spawnSync(
  "gh",
  [
    "workflow",
    "run",
    "deploy.yml",
    "--ref",
    "main",
    "-f",
    `environment=${environment}`,
    "-f",
    `sha=${sha}`,
  ],
  { stdio: "inherit" },
)
process.exitCode = result.status ?? 1

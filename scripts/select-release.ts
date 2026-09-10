import { execFileSync } from "node:child_process"
import { appendFile } from "node:fs/promises"
const [sha, environment] = process.argv.slice(2)
if (
  !sha ||
  !/^[a-f0-9]{40}$/.test(sha) ||
  !["staging", "production"].includes(environment ?? "")
)
  throw new Error("Provide a full commit SHA and deployment environment")
if (process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Run the protected main workflow")
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"])
const repository = process.env.GITHUB_REPOSITORY
if (!repository) throw new Error("Missing repository")
function github(endpoint: string) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" }))
}
if (github(`repos/${repository}/branches/main`).protected !== true)
  throw new Error("The main branch must be protected before deploying")
const runs = github(
  `repos/${repository}/actions/workflows/check.yml/runs?head_sha=${sha}&status=success&per_page=100`,
).workflow_runs as {
  id: number
  head_sha: string
  event: string
  conclusion: string
  repository: { full_name: string }
}[]
let selected: { runId: number; artifactId: number } | undefined
for (const run of runs) {
  if (
    run.head_sha !== sha ||
    run.event !== "push" ||
    run.conclusion !== "success" ||
    run.repository.full_name !== repository
  )
    continue
  const artifacts = github(
    `repos/${repository}/actions/runs/${run.id}/artifacts`,
  ).artifacts as { id: number; name: string; expired: boolean }[]
  const artifact = artifacts.find(
    (value) => value.name === `release-${environment}-${sha}` && !value.expired,
  )
  if (artifact) {
    selected = { runId: run.id, artifactId: artifact.id }
    break
  }
}
if (!selected)
  throw new Error(
    "No successful same-repository CI artifact for this SHA; rerun its Check workflow",
  )
if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output")
await appendFile(
  process.env.GITHUB_OUTPUT,
  `run-id=${selected.runId}\nartifact-id=${selected.artifactId}\n`,
)

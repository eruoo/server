import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const workflow = await readFile(
  path.join(repositoryRoot, ".github/workflows/check.yml"),
  "utf8",
)
const packageManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
) as {
  packageManager?: string
  scripts: Record<string, string | undefined>
}
const pnpmVersion = /^pnpm@([^+]+)(?:\+.*)?$/u.exec(
  packageManifest.packageManager ?? "",
)?.[1]
const workflowsDirectory = path.join(repositoryRoot, ".github/workflows")
const workflowSources = await Promise.all(
  (await readdir(workflowsDirectory))
    .filter((fileName) => /\.ya?ml$/u.test(fileName))
    .sort()
    .map(async (fileName) => ({
      fileName,
      source: await readFile(path.join(workflowsDirectory, fileName), "utf8"),
    })),
)

const getWorkflowJobs = (fileName: string, source: string) => {
  const jobs: Array<{ context: string; fileName: string; jobId: string }> = []
  let currentJob: (typeof jobs)[number] | undefined
  let insideJobs = false

  for (const line of source.split("\n")) {
    if (line === "jobs:") {
      insideJobs = true
      currentJob = undefined
      continue
    }

    if (!insideJobs) continue
    if (/^\S/u.test(line)) {
      insideJobs = false
      currentJob = undefined
      continue
    }

    const jobId = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line)?.[1]
    if (jobId) {
      currentJob = { context: jobId, fileName, jobId }
      jobs.push(currentJob)
      continue
    }

    const explicitName =
      /^    name:\s*(?:"([^"]+)"|'([^']+)'|([^#]+?))\s*(?:#.*)?$/u
        .exec(line)
        ?.slice(1)
        .find(Boolean)
        ?.trim()
    if (currentJob && explicitName) currentJob.context = explicitName
  }

  return jobs
}

const expectedCheckCommands = [
  "pnpm run format:check",
  "pnpm run lint",
  "pnpm run secret:scan",
  "pnpm run dependencies:audit",
  "pnpm run types:check",
  "pnpm run typecheck",
  "pnpm run auth-schema:check",
  "pnpm run test:config",
  "pnpm run test",
  "pnpm run test:integration",
  "pnpm run test:e2e",
  "pnpm run openapi:check",
  "pnpm run build",
  "pnpm run bundle:check",
  "pnpm run startup:check",
]

describe("GitHub CI contract", () => {
  it("checks pull requests and final main commits with a stable status name", () => {
    expect(workflow).toMatch(
      /on:\n  pull_request:\n    branches:\n      - main\n  push:\n    branches:\n      - main\n/u,
    )
    expect(workflow).toContain("permissions:\n  contents: read")
    expect(workflow).toMatch(/\n  check:\n    name: check\n/u)
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toMatch(/^\s+- production$/mu)
    expect(workflow).not.toMatch(/^\s+paths(?:-ignore)?:/mu)
    expect(workflow).not.toMatch(/^\s+[\w-]+:\s+write$/mu)
    expect(
      workflowSources
        .flatMap(({ fileName, source }) => getWorkflowJobs(fileName, source))
        .filter(({ context }) => context === "check"),
    ).toEqual([{ context: "check", fileName: "check.yml", jobId: "check" }])
  })

  it("pins the toolchain and runs the complete browser-enabled check", () => {
    const actionReferences = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("uses: "))

    expect(actionReferences).toEqual([
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "uses: pnpm/setup@703c52620218391530e48b9e8870d5c0082e1b9b # v2.1.0",
    ])
    expect(pnpmVersion).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(workflow).not.toMatch(/^\s+version:/mu)
    expect(workflow).toContain("runtime: node@24.18.0")
    expect(workflow).toContain(
      'const value = require("./package.json").packageManager',
    )
    expect(workflow).toContain(
      'test "$(pnpm --version)" = "$expected_pnpm_version"',
    )
    expect(workflow).toContain("run: pnpm install --frozen-lockfile")
    expect(workflow).toContain(
      "run: pnpm exec playwright install --with-deps chromium",
    )
    expect(workflow).toContain("run: pnpm run check")
    expect(packageManifest.scripts["check"]?.split(" && ")).toEqual(
      expectedCheckCommands,
    )
    expect(packageManifest.scripts["test:e2e"]).toBe("playwright test")
  })

  it("cannot deploy or read production credentials", () => {
    expect(workflow).not.toContain("continue-on-error")
    expect(workflow).not.toContain("deploy:production")
    expect(workflow).not.toContain("wrangler deploy")
    expect(workflow).not.toContain("d1 migrations")
    expect(workflow).not.toContain("CLOUDFLARE")
    expect(workflow).not.toMatch(/\bsecrets\./u)
  })
})

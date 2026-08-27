import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  inspectBuildOutputs,
  removeCopiedWorkerDevelopmentVars,
} from "./lib/sanitize-build"

const temporaryDirectories: string[] = []

async function createBuildOutputs() {
  const rootDirectory = await mkdtemp(
    path.join(os.tmpdir(), "eruoo-sanitize-build-test-"),
  )
  temporaryDirectories.push(rootDirectory)

  const buildDirectory = path.join(rootDirectory, "dist")
  const workerBuildDirectory = path.join(buildDirectory, "eruoo_server")
  const clientBuildDirectory = path.join(buildDirectory, "client")
  await Promise.all([
    mkdir(workerBuildDirectory, { recursive: true }),
    mkdir(clientBuildDirectory, { recursive: true }),
  ])

  return { buildDirectory, clientBuildDirectory, workerBuildDirectory }
}

async function writeBuildFile(
  buildDirectory: string,
  relativePath: string,
): Promise<string> {
  const filePath = path.join(buildDirectory, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, "fixture")
  return filePath
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe("build output sanitization", () => {
  it("finds forbidden environment names recursively in Worker and client output", async () => {
    const directories = await createBuildOutputs()
    await Promise.all([
      writeBuildFile(directories.workerBuildDirectory, ".env"),
      writeBuildFile(
        directories.workerBuildDirectory,
        "chunks/.dev.vars.production",
      ),
      writeBuildFile(directories.clientBuildDirectory, ".dev.vars"),
      writeBuildFile(
        directories.clientBuildDirectory,
        "assets/.env.production",
      ),
      writeBuildFile(directories.workerBuildDirectory, ".env-example"),
      writeBuildFile(directories.clientBuildDirectory, ".dev.vars-example"),
    ])

    const inspection = await inspectBuildOutputs(directories)

    expect(
      inspection.forbiddenEnvironmentPaths.map((filePath) =>
        path.relative(directories.buildDirectory, filePath),
      ),
    ).toEqual([
      "client/.dev.vars",
      "client/assets/.env.production",
      "eruoo_server/.env",
      "eruoo_server/chunks/.dev.vars.production",
    ])
  })

  it("collects JavaScript for bundle inspection from Worker output only", async () => {
    const directories = await createBuildOutputs()
    await Promise.all([
      writeBuildFile(directories.workerBuildDirectory, "index.js"),
      writeBuildFile(directories.workerBuildDirectory, "chunks/runtime.mjs"),
      writeBuildFile(directories.workerBuildDirectory, "chunks/ignored.cjs"),
      writeBuildFile(directories.clientBuildDirectory, "assets/app.js"),
      writeBuildFile(directories.clientBuildDirectory, "scalar/standalone.js"),
    ])

    const inspection = await inspectBuildOutputs(directories)

    expect(
      inspection.workerJavaScriptFiles.map((filePath) =>
        path.relative(directories.workerBuildDirectory, filePath),
      ),
    ).toEqual(["chunks/runtime.mjs", "index.js"])
  })

  it("removes only the copied top-level Worker .dev.vars before inspection", async () => {
    const directories = await createBuildOutputs()
    const copiedDevelopmentVars = await writeBuildFile(
      directories.workerBuildDirectory,
      ".dev.vars",
    )
    await Promise.all([
      writeBuildFile(
        directories.workerBuildDirectory,
        "nested/.dev.vars.local",
      ),
      writeBuildFile(directories.clientBuildDirectory, ".dev.vars"),
    ])

    await removeCopiedWorkerDevelopmentVars(directories.workerBuildDirectory)
    const inspection = await inspectBuildOutputs(directories)

    await expect(readFile(copiedDevelopmentVars, "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    )
    expect(
      inspection.forbiddenEnvironmentPaths.map((filePath) =>
        path.relative(directories.buildDirectory, filePath),
      ),
    ).toEqual(["client/.dev.vars", "eruoo_server/nested/.dev.vars.local"])
  })
})

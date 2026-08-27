import { readdir, rm } from "node:fs/promises"
import path from "node:path"

export interface BuildOutputInspection {
  forbiddenEnvironmentPaths: string[]
  workerJavaScriptFiles: string[]
}

interface InspectDirectoryOptions {
  collectJavaScriptFiles: boolean
  forbiddenEnvironmentPaths: string[]
  javaScriptFiles: string[]
}

function isForbiddenEnvironmentName(name: string): boolean {
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".dev.vars" ||
    name.startsWith(".dev.vars.")
  )
}

async function inspectDirectory(
  directory: string,
  options: InspectDirectoryOptions,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)

    if (isForbiddenEnvironmentName(entry.name)) {
      options.forbiddenEnvironmentPaths.push(entryPath)
    }

    if (entry.isDirectory()) {
      await inspectDirectory(entryPath, options)
      continue
    }

    if (
      options.collectJavaScriptFiles &&
      (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))
    ) {
      options.javaScriptFiles.push(entryPath)
    }
  }
}

export async function removeCopiedWorkerDevelopmentVars(
  workerBuildDirectory: string,
): Promise<void> {
  await rm(path.join(workerBuildDirectory, ".dev.vars"), { force: true })
}

export async function inspectBuildOutputs(options: {
  clientBuildDirectory: string
  workerBuildDirectory: string
}): Promise<BuildOutputInspection> {
  const forbiddenEnvironmentPaths: string[] = []
  const workerJavaScriptFiles: string[] = []

  await inspectDirectory(options.workerBuildDirectory, {
    collectJavaScriptFiles: true,
    forbiddenEnvironmentPaths,
    javaScriptFiles: workerJavaScriptFiles,
  })
  await inspectDirectory(options.clientBuildDirectory, {
    collectJavaScriptFiles: false,
    forbiddenEnvironmentPaths,
    javaScriptFiles: workerJavaScriptFiles,
  })

  forbiddenEnvironmentPaths.sort()
  workerJavaScriptFiles.sort()

  return { forbiddenEnvironmentPaths, workerJavaScriptFiles }
}

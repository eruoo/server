import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  SCALAR_ASSET_VERSION,
  SCALAR_STANDALONE_ASSET_PATH,
} from "../src/shared/scalar"
import {
  inspectBuildOutputs,
  removeCopiedWorkerDevelopmentVars,
} from "./lib/sanitize-build"

const buildDirectory = path.resolve("dist")
const workerBuildDirectory = path.join(buildDirectory, "eruoo_server")
const clientBuildDirectory = path.join(buildDirectory, "client")

await removeCopiedWorkerDevelopmentVars(workerBuildDirectory)

const { forbiddenEnvironmentPaths, workerJavaScriptFiles } =
  await inspectBuildOutputs({ clientBuildDirectory, workerBuildDirectory })

if (forbiddenEnvironmentPaths.length > 0) {
  throw new Error(
    `The production build contains local environment files: ${forbiddenEnvironmentPaths
      .map((entryPath) => path.relative(buildDirectory, entryPath))
      .join(", ")}`,
  )
}

const workerJavaScriptSources = await Promise.all(
  workerJavaScriptFiles.map(async (file) => ({
    file,
    source: await readFile(file, "utf8"),
  })),
)
const asyncHooksImportPattern =
  /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*["']node:async_hooks["']\s*\)/g
const asyncHooksImports = workerJavaScriptSources.flatMap(({ file, source }) =>
  [...source.matchAll(asyncHooksImportPattern)].map((match) => ({
    file,
    index: match.index,
    source,
  })),
)

if (asyncHooksImports.length !== 1) {
  throw new Error(
    `The Worker bundle must contain exactly one Better Auth node:async_hooks import; found ${asyncHooksImports.length}.`,
  )
}

const [asyncHooksImport] = asyncHooksImports
if (asyncHooksImport === undefined) {
  throw new Error(
    "The Worker bundle is missing the Better Auth async hooks module.",
  )
}
const asyncHooksPrelude = asyncHooksImport.source.slice(
  Math.max(0, asyncHooksImport.index - 768),
  asyncHooksImport.index,
)
const readsGlobalAsyncLocalStorage =
  /globalThis\s*(?:\.\s*AsyncLocalStorage|\[\s*["']AsyncLocalStorage["']\s*\])/.test(
    asyncHooksPrelude,
  )
const selectsResolvedGlobalBeforeImport =
  /(?:[A-Za-z_$][\w$]*|globalThis\s*\.\s*AsyncLocalStorage)\s*\?\s*Promise\s*\.\s*resolve\s*\(\s*(?:[A-Za-z_$][\w$]*|globalThis\s*\.\s*AsyncLocalStorage)\s*\)\s*:\s*$/.test(
    asyncHooksPrelude,
  )

if (!readsGlobalAsyncLocalStorage || !selectsResolvedGlobalBeforeImport) {
  throw new Error(
    `The Worker bundle is missing the pinned abort-safe Better Auth AsyncLocalStorage selection near ${path.relative(workerBuildDirectory, asyncHooksImport.file)}.`,
  )
}

const packageManifest = JSON.parse(
  await readFile(path.resolve("package.json"), "utf8"),
) as { dependencies?: Record<string, unknown> }

if (
  packageManifest.dependencies?.["@scalar/api-reference"] !==
  SCALAR_ASSET_VERSION
) {
  throw new Error(
    "The Scalar package and self-hosted asset version must be exactly aligned.",
  )
}

const scalarPackageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@scalar/api-reference"))),
  "..",
)
const sourceScalarAsset = await readFile(
  path.join(scalarPackageDirectory, "dist/browser/standalone.js"),
)
const builtScalarAsset = await readFile(
  path.join(clientBuildDirectory, SCALAR_STANDALONE_ASSET_PATH.slice(1)),
)

if (!sourceScalarAsset.equals(builtScalarAsset)) {
  throw new Error(
    "The built Scalar standalone asset does not match the pinned package.",
  )
}

try {
  await readFile(
    path.join(workerBuildDirectory, SCALAR_STANDALONE_ASSET_PATH.slice(1)),
  )
  throw new Error(
    "The Scalar standalone asset must not be bundled with the Worker.",
  )
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error
  }
}

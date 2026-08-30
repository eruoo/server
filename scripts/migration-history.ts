import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs"
import path from "node:path"

import { isProductionMigrationFileName } from "./lib/production-migrations"
import { validateProductionMigrationChecksums } from "./release-preflight-validation"

const defaultGitTimeoutMs = 10_000
const commitShaPattern = /^[0-9a-f]{40}$/u

export interface MigrationHistoryOptions {
  cwd?: string
  environment?: Readonly<Record<string, string | undefined>>
  head?: string
  timeoutMs?: number
}

export type ProductionMigrationBaseline =
  | {
      checksums: Record<string, string>
      kind: "available"
      productionCommitSha: string
      source: "production-and-candidate-first-parent-history"
    }
  | {
      checksums: Record<string, string>
      firstParentCommitSha: string
      kind: "available"
      source: "first-parent"
    }
  | { checksums: Record<string, string>; kind: "root" }
  | {
      checksums: Record<string, string>
      commitSha?: string
      kind: "unavailable"
      source: "shallow-first-parent" | "workers-build"
      warning: string
    }

export interface ProductionMigrationFileState {
  checksums: Record<string, string>
  failures: string[]
}

export function createProductionMigrationGitChildEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {}

  for (const [name, value] of Object.entries(source)) {
    const canonicalName = name.toUpperCase()
    if (
      canonicalName.startsWith("GIT_") ||
      canonicalName.startsWith("CLOUDFLARE_") ||
      canonicalName.startsWith("CF_") ||
      canonicalName.startsWith("WRANGLER_")
    ) {
      continue
    }
    environment[name] = value
  }

  environment["GIT_CONFIG_GLOBAL"] =
    process.platform === "win32" ? "NUL" : "/dev/null"
  environment["GIT_CONFIG_NOSYSTEM"] = "1"
  environment["GIT_NO_REPLACE_OBJECTS"] = "1"
  environment["GIT_TERMINAL_PROMPT"] = "0"
  return environment as NodeJS.ProcessEnv
}

function readGitText(
  args: readonly string[],
  options: MigrationHistoryOptions,
): string {
  return execFileSync("git", [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: createProductionMigrationGitChildEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? defaultGitTimeoutMs,
  }).trim()
}

function readGitBytes(
  args: readonly string[],
  options: MigrationHistoryOptions,
): Buffer {
  return execFileSync("git", [...args], {
    cwd: options.cwd,
    env: createProductionMigrationGitChildEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? defaultGitTimeoutMs,
  })
}

function normalizeRepositoryDirectory(value: string): string {
  if (path.isAbsolute(value)) {
    throw new Error(
      "The production migration directory must be repository-relative.",
    )
  }

  const normalized = path
    .normalize(value)
    .split(path.sep)
    .join("/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "")
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(
      "The production migration directory must stay inside the repository.",
    )
  }
  return normalized
}

function isRegularNonExecutableFile(status: Stats): boolean {
  return (
    status.isFile() && !status.isSymbolicLink() && (status.mode & 0o111) === 0
  )
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex")
}

export function readProductionMigrationFileState(options: {
  cwd?: string
  migrationDirectory: string
}): ProductionMigrationFileState {
  const checksums: Record<string, string> = {}
  const failures: string[] = []
  let migrationDirectory: string

  try {
    migrationDirectory = normalizeRepositoryDirectory(
      options.migrationDirectory,
    )
  } catch (error) {
    return {
      checksums,
      failures: [
        error instanceof Error ? error.message : "Invalid migration directory.",
      ],
    }
  }

  const absoluteDirectory = path.resolve(
    options.cwd ?? process.cwd(),
    migrationDirectory,
  )
  let directoryStatus: Stats
  try {
    directoryStatus = lstatSync(absoluteDirectory)
  } catch {
    return {
      checksums,
      failures: [
        `Production migration directory ${migrationDirectory} must exist.`,
      ],
    }
  }
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    return {
      checksums,
      failures: [
        `Production migration directory ${migrationDirectory} must be a real directory.`,
      ],
    }
  }

  for (const name of readdirSync(absoluteDirectory).sort()) {
    const filePath = path.join(absoluteDirectory, name)
    let status: Stats
    try {
      status = lstatSync(filePath)
    } catch {
      failures.push(`Production migration entry ${name} could not be read.`)
      continue
    }

    if (!isRegularNonExecutableFile(status)) {
      failures.push(
        `Production migration entry ${name} must be a regular non-executable file.`,
      )
      continue
    }
    if (!isProductionMigrationFileName(name)) {
      failures.push(
        `Production migration ${name} must use the approved four-digit filename format.`,
      )
      continue
    }
    checksums[name] = sha256(readFileSync(filePath))
  }

  return { checksums, failures }
}

export function resolveProductionMigrationBaselineCommitSha(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicitBaseline = source["PRODUCTION_MIGRATION_BASELINE_SHA"]
  if (source["WORKERS_CI"] === "1" && explicitBaseline !== undefined) {
    throw new Error(
      "PRODUCTION_MIGRATION_BASELINE_SHA is forbidden in Cloudflare Workers Builds.",
    )
  }
  if (source["GITHUB_ACTIONS"] !== "true") {
    if (explicitBaseline !== undefined) {
      throw new Error(
        "PRODUCTION_MIGRATION_BASELINE_SHA is reserved for GitHub Actions.",
      )
    }
    return undefined
  }
  if (explicitBaseline === undefined || explicitBaseline.length === 0) {
    throw new Error(
      "GitHub Actions must provide PRODUCTION_MIGRATION_BASELINE_SHA.",
    )
  }
  if (
    !commitShaPattern.test(explicitBaseline) ||
    /^0{40}$/u.test(explicitBaseline)
  ) {
    throw new Error(
      "PRODUCTION_MIGRATION_BASELINE_SHA must be a lowercase nonzero 40-character commit SHA.",
    )
  }
  return explicitBaseline
}

function readMigrationFileStateAtCommit(
  commitSha: string,
  migrationDirectory: string,
  options: MigrationHistoryOptions,
): ProductionMigrationFileState {
  let treeEntries: string[]
  try {
    treeEntries = readGitBytes(
      ["ls-tree", "-r", "-z", commitSha, "--", migrationDirectory],
      options,
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
  } catch (error) {
    throw new Error("Unable to list the trusted production migrations.", {
      cause: error,
    })
  }

  const checksums: Record<string, string> = {}
  const failures: string[] = []
  for (const treeEntry of treeEntries) {
    const separatorIndex = treeEntry.indexOf("\t")
    const header = treeEntry.slice(0, separatorIndex)
    const repositoryPath = treeEntry.slice(separatorIndex + 1)
    const metadata = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})$/u.exec(header)
    if (separatorIndex < 0 || !metadata) {
      throw new Error("Unable to parse a committed production migration.")
    }

    const expectedPrefix = `${migrationDirectory}/`
    const name = repositoryPath.slice(expectedPrefix.length)
    if (
      !repositoryPath.startsWith(expectedPrefix) ||
      name.includes("/") ||
      !isProductionMigrationFileName(name)
    ) {
      failures.push(
        `Committed production migration ${repositoryPath} has an invalid path.`,
      )
      continue
    }
    if (metadata[1] !== "100644" || metadata[2] !== "blob") {
      failures.push(
        `Committed production migration ${repositoryPath} must be a regular non-executable file.`,
      )
      continue
    }

    try {
      checksums[name] = sha256(
        readGitBytes(
          ["cat-file", "blob", `${commitSha}:${repositoryPath}`],
          options,
        ),
      )
    } catch (error) {
      throw new Error(
        `Unable to read trusted production migration ${repositoryPath}.`,
        { cause: error },
      )
    }
  }
  return { checksums, failures }
}

function resolveReleaseCommitSha(options: MigrationHistoryOptions): string {
  let commitSha: string
  try {
    commitSha = readGitText(
      ["rev-parse", "--verify", `${options.head ?? "HEAD"}^{commit}`],
      options,
    ).toLowerCase()
  } catch (error) {
    throw new Error("Unable to resolve the release Git commit.", {
      cause: error,
    })
  }
  if (!commitShaPattern.test(commitSha)) {
    throw new Error("Unable to resolve the release Git commit.")
  }
  return commitSha
}

function readCandidateFirstParentHistoryCommitShas(options: {
  headCommitSha: string
  migrationHistoryOptions: MigrationHistoryOptions
  productionCommitSha: string
}): string[] {
  if (options.headCommitSha === options.productionCommitSha) return []

  let historyLines: string[]
  try {
    historyLines = readGitText(
      [
        "rev-list",
        "--first-parent",
        "--reverse",
        "--parents",
        `${options.productionCommitSha}..${options.headCommitSha}`,
      ],
      options.migrationHistoryOptions,
    )
      .split("\n")
      .filter(Boolean)
  } catch (error) {
    throw new Error(
      "Unable to read the candidate first-parent migration history.",
      { cause: error },
    )
  }

  let expectedFirstParent = options.productionCommitSha
  const commitShas: string[] = []
  for (const line of historyLines) {
    const [commitSha, firstParentCommitSha] = line.split(" ")
    if (
      !commitSha ||
      !commitShaPattern.test(commitSha) ||
      firstParentCommitSha !== expectedFirstParent
    ) {
      throw new Error(
        "The trusted production migration baseline must be a readable first-parent ancestor of the release commit.",
      )
    }
    commitShas.push(commitSha)
    expectedFirstParent = commitSha
  }
  if (expectedFirstParent !== options.headCommitSha) {
    throw new Error(
      "The trusted production migration baseline must be a readable first-parent ancestor of the release commit.",
    )
  }

  return commitShas.slice(0, -1)
}

function readAuthoritativeProductionMigrationChecksums(options: {
  headCommitSha: string
  migrationDirectory: string
  migrationHistoryOptions: MigrationHistoryOptions
  productionCommitSha: string
}): Record<string, string> {
  const productionState = readMigrationFileStateAtCommit(
    options.productionCommitSha,
    options.migrationDirectory,
    options.migrationHistoryOptions,
  )
  if (productionState.failures.length > 0) {
    throw new Error(
      `The trusted production migration baseline is invalid:\n${productionState.failures
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    )
  }

  let trustedChecksums = productionState.checksums
  const historicalCommitShas = readCandidateFirstParentHistoryCommitShas({
    headCommitSha: options.headCommitSha,
    migrationHistoryOptions: options.migrationHistoryOptions,
    productionCommitSha: options.productionCommitSha,
  })
  for (const commitSha of historicalCommitShas) {
    const candidateState = readMigrationFileStateAtCommit(
      commitSha,
      options.migrationDirectory,
      options.migrationHistoryOptions,
    )
    const failures = [
      ...candidateState.failures,
      ...validateProductionMigrationChecksums({
        actualChecksums: candidateState.checksums,
        baselineChecksums: trustedChecksums,
      }),
    ]
    if (failures.length === 0) trustedChecksums = candidateState.checksums
  }
  return trustedChecksums
}

type FirstParentCommit =
  | { commitSha: string; kind: "available" }
  | { kind: "root" }
  | { commitSha: string; kind: "unavailable" }

function resolveFirstParentCommit(
  options: MigrationHistoryOptions,
): FirstParentCommit {
  const headCommitSha = resolveReleaseCommitSha(options)

  let commitContents: string
  try {
    commitContents = readGitText(["cat-file", "-p", headCommitSha], options)
  } catch (error) {
    throw new Error("Unable to read the release Git commit.", { cause: error })
  }
  const parentCommitSha = /^parent ([0-9a-f]{40})$/mu.exec(commitContents)?.[1]
  if (!parentCommitSha) return { kind: "root" }

  try {
    readGitBytes(["cat-file", "-e", `${parentCommitSha}^{commit}`], options)
  } catch {
    return { commitSha: parentCommitSha, kind: "unavailable" }
  }
  return { commitSha: parentCommitSha, kind: "available" }
}

export function readProductionMigrationBaseline(
  options: MigrationHistoryOptions & { migrationDirectory?: string } = {},
): ProductionMigrationBaseline {
  const migrationDirectory = normalizeRepositoryDirectory(
    options.migrationDirectory ?? "migrations",
  )
  const environment = options.environment ?? process.env
  const explicitBaseline =
    resolveProductionMigrationBaselineCommitSha(environment)
  if (explicitBaseline !== undefined) {
    try {
      readGitBytes(["cat-file", "-e", `${explicitBaseline}^{commit}`], options)
    } catch (error) {
      throw new Error(
        "Unable to read the trusted production migration baseline commit.",
        { cause: error },
      )
    }
    const headCommitSha = resolveReleaseCommitSha(options)
    return {
      checksums: readAuthoritativeProductionMigrationChecksums({
        headCommitSha,
        migrationDirectory,
        migrationHistoryOptions: options,
        productionCommitSha: explicitBaseline,
      }),
      kind: "available",
      productionCommitSha: explicitBaseline,
      source: "production-and-candidate-first-parent-history",
    }
  }

  if (environment["WORKERS_CI"] === "1") {
    return {
      checksums: {},
      kind: "unavailable",
      source: "workers-build",
      warning:
        "Cloudflare Workers Builds does not independently revalidate append-only migration history; this release must use the exact commit already accepted by the authoritative production-history gate inside the GitHub Actions check job.",
    }
  }

  const firstParent = resolveFirstParentCommit(options)
  if (firstParent.kind === "root") {
    return { checksums: {}, kind: "root" }
  }
  if (firstParent.kind === "unavailable") {
    return {
      checksums: {},
      commitSha: firstParent.commitSha,
      kind: "unavailable",
      source: "shallow-first-parent",
      warning:
        "Production migration history validation skipped because the direct parent is unavailable in this shallow checkout; this run must not be treated as authoritative for append-only migration history.",
    }
  }

  const firstParentState = readMigrationFileStateAtCommit(
    firstParent.commitSha,
    migrationDirectory,
    options,
  )
  if (firstParentState.failures.length > 0) {
    throw new Error(
      `The direct-parent production migration baseline is invalid:\n${firstParentState.failures
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    )
  }
  return {
    checksums: firstParentState.checksums,
    firstParentCommitSha: firstParent.commitSha,
    kind: "available",
    source: "first-parent",
  }
}

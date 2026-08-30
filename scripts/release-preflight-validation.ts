import { z } from "zod"

import {
  isProductionMigrationFileName,
  parseProductionMigrationFileName,
} from "./lib/production-migrations"

const d1IdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const accountIdPattern = /^[0-9a-f]{32}$/i
const stableSemanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const sha256Pattern = /^[0-9a-f]{64}$/u

export const productionMigrationContract = {
  generatedDirectory: "../../migrations",
  generatedPattern: "../../migrations/*.sql",
  sourceDirectory: "./migrations",
  sourcePattern: "./migrations/*.sql",
  table: "d1_migrations",
} as const

export const requiredProductionSecrets = [
  "AUDIT_IP_HASH_SECRET",
  "BETTER_AUTH_SECRETS",
  "D1_EXPORT_API_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const

export const productionCustomDomainRoutesSchema = z.tuple([
  z
    .object({
      custom_domain: z.literal(true),
      pattern: z.literal("auth.eruoo.me"),
    })
    .strict(),
])

export function hasExactProductionCustomDomainRoute(routes: unknown): boolean {
  return productionCustomDomainRoutesSchema.safeParse(routes).success
}

function hasNoConfiguredList(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.length === 0)
  )
}

export function hasNoProductionOutboundTelemetry(options: {
  logpush: unknown
  observability: unknown
  streamingTailConsumers: unknown
  tailConsumers: unknown
}): boolean {
  if (
    (options.logpush !== undefined &&
      options.logpush !== null &&
      options.logpush !== false) ||
    !hasNoConfiguredList(options.streamingTailConsumers) ||
    !hasNoConfiguredList(options.tailConsumers) ||
    typeof options.observability !== "object" ||
    options.observability === null
  ) {
    return false
  }

  const observability = options.observability as Record<string, unknown>
  const logs = observability["logs"]
  const traces = observability["traces"]
  if (
    typeof logs !== "object" ||
    logs === null ||
    typeof traces !== "object" ||
    traces === null
  ) {
    return false
  }

  const logConfiguration = logs as Record<string, unknown>
  const traceConfiguration = traces as Record<string, unknown>
  return (
    hasNoConfiguredList(logConfiguration["destinations"]) &&
    hasNoConfiguredList(traceConfiguration["destinations"]) &&
    (traceConfiguration["propagation_policy"] === undefined ||
      traceConfiguration["propagation_policy"] === null)
  )
}

const releaseRepositoryUrl = "https://github.com/eruoo/server"

function hasExactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual)
  return (
    actual.length === expected.length &&
    actualSet.size === actual.length &&
    expected.every((entry) => actualSet.has(entry))
  )
}

export function validateReleaseBindingIdentity(options: {
  deploymentAccountId: string
  generatedConfigAccountId: unknown
  generatedRuntimeAccountId: unknown
  generatedAllowedCorsOrigins: unknown
  generatedDatabaseBindingId: string | undefined
  generatedDatabaseId: unknown
  generatedSecrets: readonly string[]
  sourceConfigAccountId: unknown
  sourceRuntimeAccountId: unknown
  sourceAllowedCorsOrigins: unknown
  sourceDatabaseBindingId: string | undefined
  sourceDatabaseId: unknown
  sourceSecrets: readonly string[]
}): string[] {
  const failures: string[] = []
  const sourceDatabaseBindingId = options.sourceDatabaseBindingId ?? ""

  if (!d1IdPattern.test(sourceDatabaseBindingId)) {
    failures.push("The production DB binding needs an explicit D1 database_id.")
  }
  if (options.generatedDatabaseBindingId !== sourceDatabaseBindingId) {
    failures.push("The production D1 database_id must survive the Vite build.")
  }
  if (options.sourceDatabaseId !== sourceDatabaseBindingId) {
    failures.push(
      "D1_DATABASE_ID must exactly match the production DB binding.",
    )
  }
  if (options.generatedDatabaseId !== sourceDatabaseBindingId) {
    failures.push(
      "Generated D1_DATABASE_ID must exactly match the production DB binding.",
    )
  }
  const sourceConfigAccountId =
    typeof options.sourceConfigAccountId === "string"
      ? options.sourceConfigAccountId
      : ""
  if (!accountIdPattern.test(sourceConfigAccountId)) {
    failures.push(
      "The production Wrangler environment must pin an explicit 32-character account_id.",
    )
  }
  if (options.deploymentAccountId !== sourceConfigAccountId) {
    failures.push(
      "The production deploy environment must exactly match the production account_id.",
    )
  }
  if (options.sourceRuntimeAccountId !== sourceConfigAccountId) {
    failures.push("CF_ACCOUNT_ID must exactly match the production account_id.")
  }
  if (options.generatedConfigAccountId !== sourceConfigAccountId) {
    failures.push(
      "The production account_id must survive the Vite build unchanged.",
    )
  }
  if (options.generatedRuntimeAccountId !== sourceConfigAccountId) {
    failures.push(
      "Generated CF_ACCOUNT_ID must exactly match the production account_id.",
    )
  }
  if (
    options.sourceAllowedCorsOrigins !== "[]" ||
    options.generatedAllowedCorsOrigins !== "[]"
  ) {
    failures.push(
      "Production ALLOWED_CORS_ORIGINS must remain the exact empty JSON array in source and generated configs.",
    )
  }
  if (!hasExactSet(options.sourceSecrets, requiredProductionSecrets)) {
    failures.push(
      "The production required-secret manifest does not match the release contract.",
    )
  }
  if (!hasExactSet(options.generatedSecrets, requiredProductionSecrets)) {
    failures.push(
      "The generated required-secret manifest does not match the release contract.",
    )
  }

  return failures
}

export function validateProductionMigrationBindingContract(options: {
  generatedBindingCount: number
  generatedDirectory: unknown
  generatedPattern: unknown
  generatedTable: unknown
  sourceBindingCount: number
  sourceDirectory: unknown
  sourcePattern: unknown
  sourceTable: unknown
}): string[] {
  const failures: string[] = []

  if (options.sourceBindingCount !== 1 || options.generatedBindingCount !== 1) {
    failures.push(
      "Source and generated production configs must contain exactly one D1 binding.",
    )
  }
  if (
    options.sourceDirectory !== productionMigrationContract.sourceDirectory ||
    options.sourcePattern !== productionMigrationContract.sourcePattern ||
    options.sourceTable !== productionMigrationContract.table
  ) {
    failures.push(
      "The production DB binding must use the approved source migration directory, pattern, and table.",
    )
  }
  if (
    options.generatedDirectory !==
      productionMigrationContract.generatedDirectory ||
    options.generatedPattern !== productionMigrationContract.generatedPattern ||
    options.generatedTable !== productionMigrationContract.table
  ) {
    failures.push(
      "The generated production DB binding must preserve the approved migration directory, pattern, and table relative to its config file.",
    )
  }

  return failures
}

export function validateReleaseVersionIdentity(options: {
  changelog: string
  openApiVersion: string
  packageVersion: string
}): string[] {
  const failures: string[] = []
  const changelogLines = new Set(options.changelog.split(/\r?\n/u))

  if (!stableSemanticVersionPattern.test(options.packageVersion)) {
    failures.push(
      "package.json version must be a stable MAJOR.MINOR.PATCH Semantic Version.",
    )
  }
  if (options.openApiVersion !== options.packageVersion) {
    failures.push(
      "The OpenAPI document version must exactly match package.json.",
    )
  }
  if (!changelogLines.has(`## [${options.packageVersion}]`)) {
    failures.push(
      "CHANGELOG.md must contain a release heading for the package version.",
    )
  }
  if (
    !changelogLines.has(
      `[Unreleased]: ${releaseRepositoryUrl}/compare/v${options.packageVersion}...HEAD`,
    )
  ) {
    failures.push(
      "CHANGELOG.md must compare Unreleased changes from the package version tag.",
    )
  }
  if (
    !changelogLines.has(
      `[${options.packageVersion}]: ${releaseRepositoryUrl}/releases/tag/v${options.packageVersion}`,
    )
  ) {
    failures.push(
      "CHANGELOG.md must link the package version to its matching release tag.",
    )
  }

  return failures
}

export function validateProductionMigrationChecksums(options: {
  actualChecksums: Readonly<Record<string, string>>
  baselineChecksums: Readonly<Record<string, string>>
}): string[] {
  const failures: string[] = []
  const actualNames = Object.keys(options.actualChecksums).sort()
  const actualMigrationSequences = new Map<number, string>()

  for (const name of actualNames) {
    const migrationName = parseProductionMigrationFileName(name)
    if (migrationName === undefined) {
      failures.push(
        `Production migration ${name} must use the approved four-digit filename format.`,
      )
      continue
    }

    const existingName = actualMigrationSequences.get(migrationName.sequence)
    if (existingName !== undefined) {
      failures.push(
        `Production migrations ${existingName} and ${name} must not share sequence ${migrationName.sequenceText}.`,
      )
    } else {
      actualMigrationSequences.set(migrationName.sequence, name)
    }
  }

  const historicalSequences = Object.keys(options.baselineChecksums)
    .map((name) => parseProductionMigrationFileName(name)?.sequence)
    .filter((sequence): sequence is number => sequence !== undefined)
  const historicalMaximumSequence =
    historicalSequences.length === 0 ? -1 : Math.max(...historicalSequences)

  for (const name of actualNames) {
    if (Object.hasOwn(options.baselineChecksums, name)) continue
    const migrationName = parseProductionMigrationFileName(name)
    if (
      migrationName !== undefined &&
      migrationName.sequence <= historicalMaximumSequence
    ) {
      failures.push(
        `New production migration ${name} must use a sequence greater than the trusted baseline maximum ${String(historicalMaximumSequence).padStart(4, "0")}.`,
      )
    }
  }

  for (const [name, checksum] of Object.entries(options.baselineChecksums)) {
    if (
      !isProductionMigrationFileName(name) ||
      !sha256Pattern.test(checksum) ||
      options.actualChecksums[name] !== checksum
    ) {
      failures.push(
        `Production migration ${name} must remain byte-for-byte identical to its trusted Git baseline.`,
      )
    }
  }

  return failures
}

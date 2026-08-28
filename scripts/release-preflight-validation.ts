const d1IdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const accountIdPattern = /^[0-9a-f]{32}$/i
const stableSemanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

export const requiredProductionSecrets = [
  "AUDIT_IP_HASH_SECRET",
  "BETTER_AUTH_SECRETS",
  "D1_EXPORT_API_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const

const releaseRepositoryUrl = "https://github.com/eruoo/server"

function hasExactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual)
  return (
    actualSet.size === expected.length &&
    expected.every((entry) => actualSet.has(entry))
  )
}

export function validateReleaseBindingIdentity(options: {
  generatedAccountId: unknown
  generatedAllowedCorsOrigins: unknown
  generatedDatabaseBindingId: string | undefined
  generatedDatabaseId: unknown
  generatedSecrets: readonly string[]
  sourceAccountId: unknown
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
  if (
    typeof options.sourceAccountId !== "string" ||
    !accountIdPattern.test(options.sourceAccountId)
  ) {
    failures.push("CF_ACCOUNT_ID must be an explicit 32-character account ID.")
  }
  if (options.generatedAccountId !== options.sourceAccountId) {
    failures.push("CF_ACCOUNT_ID must survive the Vite build unchanged.")
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

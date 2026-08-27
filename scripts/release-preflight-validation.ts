const d1IdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const accountIdPattern = /^[0-9a-f]{32}$/i

export const requiredProductionSecrets = [
  "AUDIT_IP_HASH_SECRET",
  "BETTER_AUTH_SECRETS",
  "D1_EXPORT_API_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const

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

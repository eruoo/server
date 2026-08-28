import { describe, expect, it } from "vitest"

import {
  requiredProductionSecrets,
  validateReleaseBindingIdentity,
  validateReleaseVersionIdentity,
} from "./release-preflight-validation"

const accountId = "a".repeat(32)
const databaseId = "11111111-1111-4111-8111-111111111111"

function validInput() {
  return {
    generatedAccountId: accountId,
    generatedAllowedCorsOrigins: "[]",
    generatedDatabaseBindingId: databaseId,
    generatedDatabaseId: databaseId,
    generatedSecrets: [...requiredProductionSecrets],
    sourceAccountId: accountId,
    sourceAllowedCorsOrigins: "[]",
    sourceDatabaseBindingId: databaseId,
    sourceDatabaseId: databaseId,
    sourceSecrets: [...requiredProductionSecrets],
  }
}

describe("production release binding validation", () => {
  it("accepts matching source and generated identities", () => {
    expect(validateReleaseBindingIdentity(validInput())).toEqual([])
  })

  it("fails closed when generated vars or the secret manifest drift", () => {
    expect(
      validateReleaseBindingIdentity({
        ...validInput(),
        generatedAccountId: "",
        generatedDatabaseId: "",
        generatedSecrets: requiredProductionSecrets.slice(1),
      }),
    ).toEqual([
      "Generated D1_DATABASE_ID must exactly match the production DB binding.",
      "CF_ACCOUNT_ID must survive the Vite build unchanged.",
      "The generated required-secret manifest does not match the release contract.",
    ])
  })

  it("rejects unset source identifiers even if the generated file matches", () => {
    expect(
      validateReleaseBindingIdentity({
        ...validInput(),
        generatedAccountId: "",
        generatedDatabaseBindingId: undefined,
        generatedDatabaseId: "",
        sourceAccountId: "",
        sourceDatabaseBindingId: undefined,
        sourceDatabaseId: "",
      }),
    ).toContain("The production DB binding needs an explicit D1 database_id.")
  })

  it("requires the production CORS allowlist to remain empty in both configs", () => {
    expect(
      validateReleaseBindingIdentity({
        ...validInput(),
        generatedAllowedCorsOrigins: '["https://web.example.invalid"]',
      }),
    ).toContain(
      "Production ALLOWED_CORS_ORIGINS must remain the exact empty JSON array in source and generated configs.",
    )

    expect(
      validateReleaseBindingIdentity({
        ...validInput(),
        sourceAllowedCorsOrigins: "[ ]",
      }),
    ).toContain(
      "Production ALLOWED_CORS_ORIGINS must remain the exact empty JSON array in source and generated configs.",
    )
  })
})

const packageVersion = "0.0.1"

function validVersionInput() {
  return {
    changelog: [
      `## [${packageVersion}]`,
      `[Unreleased]: https://github.com/eruoo/server/compare/v${packageVersion}...HEAD`,
      `[${packageVersion}]: https://github.com/eruoo/server/releases/tag/v${packageVersion}`,
    ].join("\n"),
    openApiVersion: packageVersion,
    packageVersion,
  }
}

describe("production release version validation", () => {
  it("accepts aligned package, OpenAPI, and changelog versions", () => {
    expect(validateReleaseVersionIdentity(validVersionInput())).toEqual([])
  })

  it("rejects an OpenAPI version that differs from the package version", () => {
    expect(
      validateReleaseVersionIdentity({
        ...validVersionInput(),
        openApiVersion: "0.1.0",
      }),
    ).toContain("The OpenAPI document version must exactly match package.json.")
  })

  it.each(["not-semver", "0.0.01", "v0.0.1", "0.0.1-preview.1"])(
    "rejects a non-stable Semantic Version: %s",
    (invalidVersion) => {
      const input = validVersionInput()

      expect(
        validateReleaseVersionIdentity({
          changelog: input.changelog.replaceAll(packageVersion, invalidVersion),
          openApiVersion: invalidVersion,
          packageVersion: invalidVersion,
        }),
      ).toContain(
        "package.json version must be a stable MAJOR.MINOR.PATCH Semantic Version.",
      )
    },
  )

  it("requires the release heading and both version links", () => {
    expect(
      validateReleaseVersionIdentity({
        ...validVersionInput(),
        changelog: "## [Unreleased]\n",
      }),
    ).toEqual([
      "CHANGELOG.md must contain a release heading for the package version.",
      "CHANGELOG.md must compare Unreleased changes from the package version tag.",
      "CHANGELOG.md must link the package version to its matching release tag.",
    ])
  })
})

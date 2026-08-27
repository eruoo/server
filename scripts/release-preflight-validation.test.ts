import { describe, expect, it } from "vitest"

import {
  requiredProductionSecrets,
  validateReleaseBindingIdentity,
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

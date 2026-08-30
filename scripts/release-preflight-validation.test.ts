import { describe, expect, it } from "vitest"

import {
  hasExactProductionCustomDomainRoute,
  hasNoProductionOutboundTelemetry,
  productionMigrationContract,
  requiredProductionSecrets,
  validateProductionMigrationBindingContract,
  validateProductionMigrationChecksums,
  validateReleaseBindingIdentity,
  validateReleaseVersionIdentity,
} from "./release-preflight-validation"

const accountId = "a".repeat(32)
const databaseId = "11111111-1111-4111-8111-111111111111"

describe("production custom domain route validation", () => {
  const approvedRoute = { custom_domain: true, pattern: "auth.eruoo.me" }

  it("accepts exactly the approved custom domain route", () => {
    expect(hasExactProductionCustomDomainRoute([approvedRoute])).toBe(true)
  })

  it.each([
    { name: "no route", routes: [] },
    { name: "a duplicate route", routes: [approvedRoute, approvedRoute] },
    {
      name: "an extra route",
      routes: [approvedRoute, { pattern: "example.com/*" }],
    },
    {
      name: "an extra route property",
      routes: [{ ...approvedRoute, zone_name: "eruoo.me" }],
    },
    {
      name: "a non-custom-domain route",
      routes: [{ custom_domain: false, pattern: "auth.eruoo.me" }],
    },
  ])("rejects $name", ({ routes }) => {
    expect(hasExactProductionCustomDomainRoute(routes)).toBe(false)
  })
})

describe("production outbound telemetry validation", () => {
  const approvedOptions = {
    logpush: undefined,
    observability: {
      logs: { enabled: true },
      traces: { enabled: false },
    },
    streamingTailConsumers: undefined,
    tailConsumers: undefined,
  }

  it("accepts an observability config without outbound consumers", () => {
    expect(hasNoProductionOutboundTelemetry(approvedOptions)).toBe(true)
    expect(
      hasNoProductionOutboundTelemetry({
        ...approvedOptions,
        logpush: false,
        streamingTailConsumers: [],
        tailConsumers: [],
      }),
    ).toBe(true)
  })

  it.each([
    {
      name: "logpush",
      options: { ...approvedOptions, logpush: true },
    },
    {
      name: "a tail consumer",
      options: { ...approvedOptions, tailConsumers: [{ service: "sink" }] },
    },
    {
      name: "a streaming tail consumer",
      options: {
        ...approvedOptions,
        streamingTailConsumers: [{ service: "streaming-sink" }],
      },
    },
    {
      name: "a log destination",
      options: {
        ...approvedOptions,
        observability: {
          ...approvedOptions.observability,
          logs: { destinations: ["external"], enabled: true },
        },
      },
    },
    {
      name: "a trace destination",
      options: {
        ...approvedOptions,
        observability: {
          ...approvedOptions.observability,
          traces: { destinations: ["external"], enabled: false },
        },
      },
    },
    {
      name: "a trace propagation policy",
      options: {
        ...approvedOptions,
        observability: {
          ...approvedOptions.observability,
          traces: { enabled: false, propagation_policy: "all" },
        },
      },
    },
  ])("rejects $name", ({ options }) => {
    expect(hasNoProductionOutboundTelemetry(options)).toBe(false)
  })
})

describe("production migration binding contract", () => {
  const validContract = {
    generatedBindingCount: 1,
    generatedDirectory: productionMigrationContract.generatedDirectory,
    generatedPattern: productionMigrationContract.generatedPattern,
    generatedTable: productionMigrationContract.table,
    sourceBindingCount: 1,
    sourceDirectory: productionMigrationContract.sourceDirectory,
    sourcePattern: productionMigrationContract.sourcePattern,
    sourceTable: productionMigrationContract.table,
  }

  it("accepts the approved source and generated migration locations", () => {
    expect(validateProductionMigrationBindingContract(validContract)).toEqual(
      [],
    )
  })

  it("rejects an alternate migration source or ledger table", () => {
    expect(
      validateProductionMigrationBindingContract({
        ...validContract,
        sourceDirectory: "./alternate-migrations",
        sourcePattern: "./alternate-migrations/*.sql",
        sourceTable: "alternate_d1_migrations",
      }),
    ).toContain(
      "The production DB binding must use the approved source migration directory, pattern, and table.",
    )
  })

  it("rejects generated paths that are not relative to the built config", () => {
    expect(
      validateProductionMigrationBindingContract({
        ...validContract,
        generatedDirectory: "./migrations",
        generatedPattern: "./migrations/*.sql",
      }),
    ).toContain(
      "The generated production DB binding must preserve the approved migration directory, pattern, and table relative to its config file.",
    )
  })
})

describe("production migration history validation", () => {
  const firstChecksum = "a".repeat(64)
  const secondChecksum = "b".repeat(64)
  const validOptions = {
    actualChecksums: {
      "0001_foundation.sql": firstChecksum,
      "0002_expand.sql": secondChecksum,
    },
    baselineChecksums: {
      "0001_foundation.sql": firstChecksum,
    },
  }

  it("accepts unchanged historical migrations and a new sequence", () => {
    expect(validateProductionMigrationChecksums(validOptions)).toEqual([])
  })

  it.each([
    {
      expectedFailure:
        "Production migration 0001_foundation.sql must remain byte-for-byte identical to its trusted Git baseline.",
      name: "a changed migration",
      options: {
        ...validOptions,
        actualChecksums: {
          ...validOptions.actualChecksums,
          "0001_foundation.sql": "c".repeat(64),
        },
      },
    },
    {
      expectedFailure:
        "Production migration 0001_foundation.sql must remain byte-for-byte identical to its trusted Git baseline.",
      name: "a previously committed migration was deleted",
      options: {
        ...validOptions,
        actualChecksums: {
          "0002_expand.sql": secondChecksum,
        },
      },
    },
    {
      expectedFailure:
        "Production migration 0002__expand.sql must use the approved four-digit filename format.",
      name: "a filename rejected by the restore planner",
      options: {
        actualChecksums: {
          "0001_foundation.sql": firstChecksum,
          "0002__expand.sql": secondChecksum,
        },
        baselineChecksums: validOptions.baselineChecksums,
      },
    },
  ])("rejects $name", ({ expectedFailure, options }) => {
    expect(validateProductionMigrationChecksums(options)).toContain(
      expectedFailure,
    )
  })

  it("rejects a back-numbered migration added after historical migrations", () => {
    expect(
      validateProductionMigrationChecksums({
        actualChecksums: {
          "0000_late.sql": secondChecksum,
          "0001_foundation.sql": firstChecksum,
        },
        baselineChecksums: {
          "0001_foundation.sql": firstChecksum,
        },
      }),
    ).toContain(
      "New production migration 0000_late.sql must use a sequence greater than the trusted baseline maximum 0001.",
    )
  })

  it("rejects different migration names that share a sequence", () => {
    expect(
      validateProductionMigrationChecksums({
        ...validOptions,
        actualChecksums: {
          ...validOptions.actualChecksums,
          "0002_duplicate.sql": secondChecksum,
        },
      }),
    ).toContain(
      "Production migrations 0002_duplicate.sql and 0002_expand.sql must not share sequence 0002.",
    )
  })
})

function validInput() {
  return {
    deploymentAccountId: accountId,
    generatedConfigAccountId: accountId,
    generatedRuntimeAccountId: accountId,
    generatedAllowedCorsOrigins: "[]",
    generatedDatabaseBindingId: databaseId,
    generatedDatabaseId: databaseId,
    generatedSecrets: [...requiredProductionSecrets],
    sourceConfigAccountId: accountId,
    sourceRuntimeAccountId: accountId,
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
        generatedRuntimeAccountId: "",
        generatedDatabaseId: "",
        generatedSecrets: requiredProductionSecrets.slice(1),
      }),
    ).toEqual([
      "Generated D1_DATABASE_ID must exactly match the production DB binding.",
      "Generated CF_ACCOUNT_ID must exactly match the production account_id.",
      "The generated required-secret manifest does not match the release contract.",
    ])
  })

  it.each([
    {
      expectedFailure:
        "The production deploy environment must exactly match the production account_id.",
      field: "deploymentAccountId",
      value: "b".repeat(32),
    },
    {
      expectedFailure:
        "The production Wrangler environment must pin an explicit 32-character account_id.",
      field: "sourceConfigAccountId",
      value: "",
    },
    {
      expectedFailure:
        "CF_ACCOUNT_ID must exactly match the production account_id.",
      field: "sourceRuntimeAccountId",
      value: "b".repeat(32),
    },
    {
      expectedFailure:
        "The production account_id must survive the Vite build unchanged.",
      field: "generatedConfigAccountId",
      value: "b".repeat(32),
    },
    {
      expectedFailure:
        "Generated CF_ACCOUNT_ID must exactly match the production account_id.",
      field: "generatedRuntimeAccountId",
      value: "b".repeat(32),
    },
  ] as const)(
    "rejects drift in the $field account identity copy",
    ({ expectedFailure, field, value }) => {
      expect(
        validateReleaseBindingIdentity({
          ...validInput(),
          [field]: value,
        }),
      ).toContain(expectedFailure)
    },
  )

  it("rejects unset source identifiers even if the generated file matches", () => {
    expect(
      validateReleaseBindingIdentity({
        ...validInput(),
        generatedConfigAccountId: "",
        generatedRuntimeAccountId: "",
        generatedDatabaseBindingId: undefined,
        generatedDatabaseId: "",
        sourceConfigAccountId: "",
        sourceRuntimeAccountId: "",
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

  it.each(["sourceSecrets", "generatedSecrets"] as const)(
    "rejects a duplicated required Secret in %s",
    (manifest) => {
      expect(
        validateReleaseBindingIdentity({
          ...validInput(),
          [manifest]: [
            ...requiredProductionSecrets,
            requiredProductionSecrets[0],
          ],
        }),
      ).toContain(
        manifest === "sourceSecrets"
          ? "The production required-secret manifest does not match the release contract."
          : "The generated required-secret manifest does not match the release contract.",
      )
    },
  )
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

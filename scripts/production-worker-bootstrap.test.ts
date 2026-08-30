import { describe, expect, it } from "vitest"

import {
  assertProductionWorkerBootstrapPostcondition,
  assertProductionWorkerBootstrapPrecondition,
  createProductionWorkerBootstrapIdentity,
  createProductionWorkerBootstrapWranglerArguments,
  createProductionWorkerBootstrapWranglerEnvironment,
  parseProductionWorkerBootstrapVersionId,
  readProductionWorkerBootstrapApiToken,
  type ProductionWorkerBootstrapApiRequest,
  type ProductionWorkerBootstrapCommandResult,
  type ProductionWorkerBootstrapInspector,
} from "./production-worker-bootstrap"
import { requiredProductionSecrets } from "./release-preflight-validation"

const workerName = "eruoo-server-production"
const accountId = "a".repeat(32)
const templateVersionId = "b8fbfb27-d746-4395-9e5d-6c80a6c9c256"
const activeVersionId = "11111111-2222-4333-8444-555555555555"
const commitSha = "3390b8c3d1efbe859597d28904c67cd25b574114"
const attemptId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const identity = createProductionWorkerBootstrapIdentity(
  templateVersionId,
  commitSha,
  () => attemptId,
)

function generatedConfig(): Record<string, unknown> {
  return {
    account_id: accountId,
    d1_databases: [
      {
        binding: "DB",
        database_id: "652f931e-a445-46fa-bc2b-72be095fdc01",
      },
    ],
    name: workerName,
    r2_buckets: [{ binding: "BACKUPS", bucket_name: "eruoo-server-backups" }],
    ratelimits: [
      {
        name: "AUTH_RATE_LIMITER",
        namespace_id: "1002",
        simple: { limit: 10, period: 60 },
      },
    ],
    routes: [{ custom_domain: true, pattern: "auth.eruoo.me" }],
    secrets: { required: [...requiredProductionSecrets] },
    streaming_tail_consumers: [],
    vars: {
      APP_ENV: "production",
      CF_ACCOUNT_ID: accountId,
      D1_DATABASE_ID: "652f931e-a445-46fa-bc2b-72be095fdc01",
    },
    version_metadata: { binding: "CF_VERSION_METADATA" },
    workflows: [
      {
        binding: "DATABASE_BACKUP_WORKFLOW",
        class_name: "DatabaseBackupWorkflow",
        name: "eruoo-database-backup",
        schedules: ["0 19 * * 6"],
      },
    ],
  }
}

function secrets(): Record<string, unknown>[] {
  return requiredProductionSecrets.map((name) => ({
    name,
    type: "secret_text",
  }))
}

function templateDeployment(): Record<string, unknown> {
  return {
    id: "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb",
    source: "dash_template",
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: templateVersionId }],
  }
}

function activeDeployment(): Record<string, unknown> {
  return {
    annotations: { "workers/message": identity.message },
    id: "cccccccc-1111-4222-8333-dddddddddddd",
    source: "wrangler",
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: activeVersionId }],
  }
}

function bindings(): Record<string, unknown>[] {
  const config = generatedConfig()
  return [
    ...Object.entries(config["vars"] as Record<string, string>).map(
      ([name, text]) => ({ name, text, type: "plain_text" }),
    ),
    ...requiredProductionSecrets.map((name) => ({
      name,
      type: "inherit",
      version_id: "latest",
    })),
    {
      id: "652f931e-a445-46fa-bc2b-72be095fdc01",
      name: "DB",
      type: "d1",
    },
    {
      bucket_name: "eruoo-server-backups",
      name: "BACKUPS",
      type: "r2_bucket",
    },
    {
      class_name: "DatabaseBackupWorkflow",
      name: "DATABASE_BACKUP_WORKFLOW",
      type: "workflow",
      workflow_name: "eruoo-database-backup",
    },
    {
      name: "AUTH_RATE_LIMITER",
      namespace_id: "1002",
      simple: { limit: 10, period: 60 },
      type: "ratelimit",
    },
    { name: "CF_VERSION_METADATA", type: "version_metadata" },
  ]
}

function activeVersion(): Record<string, unknown> {
  return {
    annotations: {
      "workers/message": identity.message,
      "workers/tag": identity.tag,
    },
    id: activeVersionId,
    metadata: { source: "wrangler" },
    resources: {
      bindings: bindings(),
      script: {
        handlers: ["scheduled", "fetch"],
        last_deployed_from: "wrangler",
      },
    },
  }
}

type Dynamic<T> = T | ((read: number) => T)

interface HarnessOverrides {
  apiThrows?: boolean
  commandFailure?: "deployment" | "secrets" | "version"
  config?: unknown
  deployment?: Dynamic<unknown>
  domainChangeset?: { body: unknown; status: number }
  domains?: { body: unknown; status: number }
  secrets?: unknown
  scriptSettings?: { body: unknown; status: number }
  version?: unknown
}

function resolveDynamic<T>(
  value: Dynamic<T> | undefined,
  read: number,
  base: T,
): T {
  return typeof value === "function"
    ? (value as (read: number) => T)(read)
    : (value ?? base)
}

function createHarness(
  phase: "post" | "pre",
  overrides: HarnessOverrides = {},
): {
  apiRequests: { path: string; request: ProductionWorkerBootstrapApiRequest }[]
  calls: string[]
  inspector: ProductionWorkerBootstrapInspector
  waits: number[]
} {
  const calls: string[] = []
  const waits: number[] = []
  const apiRequests: {
    path: string
    request: ProductionWorkerBootstrapApiRequest
  }[] = []
  let deploymentReads = 0

  return {
    apiRequests,
    calls,
    inspector: {
      readCloudflareApi: async (path, request = {}) => {
        apiRequests.push({ path, request })
        if (overrides.apiThrows) throw new Error("raw api body")
        const fallback = path.includes("changeset")
          ? {
              body: {
                result: {
                  added: [{ hostname: "auth.eruoo.me" }],
                  conflicting: [],
                  removed: [],
                  updated: [],
                },
                success: true,
              },
              status: 200,
            }
          : path.endsWith("/script-settings")
            ? {
                body: {
                  result: {
                    logpush: false,
                    observability: {
                      logs: { enabled: true },
                      traces: { enabled: false },
                    },
                    streaming_tail_consumers: null,
                    tail_consumers: null,
                  },
                  success: true,
                },
                status: 200,
              }
            : {
                body: {
                  result: [
                    {
                      environment: "production",
                      hostname: "auth.eruoo.me",
                      service: workerName,
                    },
                  ],
                  result_info: { total_count: 8 },
                  success: true,
                },
                status: 200,
              }
        if (path.includes("changeset")) {
          return overrides.domainChangeset ?? fallback
        }
        if (path.endsWith("/script-settings")) {
          return overrides.scriptSettings ?? fallback
        }
        return overrides.domains ?? fallback
      },
      readGeneratedConfig: async () => overrides.config ?? generatedConfig(),
      runWrangler: async (args) => {
        calls.push(args.join(" "))
        let key: "deployment" | "secrets" | "version"
        let body: unknown
        if (args[0] === "deployments") {
          key = "deployment"
          deploymentReads += 1
          body = resolveDynamic(
            overrides.deployment,
            deploymentReads,
            phase === "pre" ? templateDeployment() : activeDeployment(),
          )
        } else if (args[0] === "versions") {
          key = "version"
          body = overrides.version ?? activeVersion()
        } else {
          key = "secrets"
          body = overrides.secrets ?? secrets()
        }
        const failed = overrides.commandFailure === key
        return {
          exitCode: failed ? 1 : 0,
          stderr: failed ? "raw sensitive stderr" : "",
          stdout: failed ? "" : JSON.stringify(body),
        } satisfies ProductionWorkerBootstrapCommandResult
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds)
      },
    },
    waits,
  }
}

describe("production Worker bootstrap identity", () => {
  it("requires an explicit lowercase UUID and binds the attempt to the commit", () => {
    expect(parseProductionWorkerBootstrapVersionId(undefined)).toBeUndefined()
    expect(parseProductionWorkerBootstrapVersionId(templateVersionId)).toBe(
      templateVersionId,
    )
    for (const invalid of [
      templateVersionId.toUpperCase(),
      ` ${templateVersionId}`,
      "not-a-version",
    ]) {
      expect(() => parseProductionWorkerBootstrapVersionId(invalid)).toThrow(
        "lowercase UUID",
      )
    }
    expect(identity).toEqual({
      commitSha,
      message: `eruoo-server production bootstrap ${commitSha} bootstrap-${commitSha.slice(0, 12)}-${attemptId}`,
      tag: `bootstrap-${commitSha.slice(0, 12)}-${attemptId}`,
      templateVersionId,
    })
  })
})

describe("production Worker bootstrap inspection boundary", () => {
  it("pins Wrangler inputs, preserves proxies, and retains only the API token", () => {
    const environment = createProductionWorkerBootstrapWranglerEnvironment({
      CF_ACCOUNT_ID: "wrong",
      CLOUDFLARE_API_TOKEN: "token",
      HTTPS_PROXY: "http://proxy.example",
      WRANGLER_CI_OVERRIDE_NAME: "wrong",
    })
    expect(environment).toMatchObject({
      CLOUDFLARE_API_TOKEN: "token",
      HTTPS_PROXY: "http://proxy.example",
      WRANGLER_API_ENVIRONMENT: "production",
      WRANGLER_CI_OVERRIDE_NAME: workerName,
      WRANGLER_WRITE_LOGS: "false",
    })
    expect(environment["CF_ACCOUNT_ID"]).toBeUndefined()
    expect(readProductionWorkerBootstrapApiToken(environment)).toBe("token")
    expect(
      createProductionWorkerBootstrapWranglerArguments(["secret", "list"]),
    ).toEqual([
      "exec",
      "wrangler",
      "secret",
      "list",
      "--config",
      "dist/eruoo_server/wrangler.json",
      "--env-file",
      "/dev/null",
    ])
    expect(() =>
      createProductionWorkerBootstrapWranglerArguments([
        "secret",
        "list",
        "--config=other.json",
      ]),
    ).toThrow("may not override")
  })

  it("rejects missing tokens and endpoint or log overrides", () => {
    expect(() => readProductionWorkerBootstrapApiToken({})).toThrow(
      "requires CLOUDFLARE_API_TOKEN",
    )
    expect(() =>
      createProductionWorkerBootstrapWranglerEnvironment({
        CLOUDFLARE_API_BASE_URL: "https://example.invalid",
      }),
    ).toThrow("endpoint overrides")
    expect(() =>
      createProductionWorkerBootstrapWranglerEnvironment({
        WRANGLER_LOG_PATH: "/tmp/raw.log",
      }),
    ).toThrow("WRANGLER_LOG_PATH")
  })
})

describe("production Worker bootstrap precondition", () => {
  it("checks only the pinned active template, required Secrets, core config, and domain conflict", async () => {
    const harness = createHarness("pre")
    await expect(
      assertProductionWorkerBootstrapPrecondition(
        templateVersionId,
        harness.inspector,
      ),
    ).resolves.toBeUndefined()
    expect(harness.calls).toEqual([
      `deployments status --name ${workerName} --json`,
      `secret list --name ${workerName} --format json`,
    ])
    expect(harness.apiRequests).toEqual([
      {
        path: `/accounts/${accountId}/workers/scripts/${workerName}/domains/changeset?replace_state=true`,
        request: {
          body: [{ hostname: "auth.eruoo.me" }],
          method: "POST",
        },
      },
    ])
  })

  it.each([
    [
      "a different active version",
      { deployment: { ...templateDeployment(), source: "wrangler" } },
      "pinned Dashboard template",
    ],
    [
      "a changed Secret set",
      { secrets: [...secrets(), { name: "EXTRA", type: "secret_text" }] },
      "Secret manifest",
    ],
    [
      "a changed generated identity",
      { config: { ...generatedConfig(), account_id: "b".repeat(32) } },
      "approved core identity",
    ],
    [
      "a conflicting domain",
      {
        domainChangeset: {
          body: {
            result: {
              added: [],
              conflicting: [{ hostname: "auth.eruoo.me" }],
              removed: [],
              updated: [],
            },
            success: true,
          },
          status: 200,
        },
      },
      "without conflict",
    ],
  ])("rejects %s", async (_name, overrides, message) => {
    const harness = createHarness("pre", overrides)
    await expect(
      assertProductionWorkerBootstrapPrecondition(
        templateVersionId,
        harness.inspector,
      ),
    ).rejects.toThrow(message)
  })

  it("does not expose Wrangler stderr or an API exception", async () => {
    const wranglerFailure = createHarness("pre", {
      commandFailure: "deployment",
    })
    const apiFailure = createHarness("pre", { apiThrows: true })
    await expect(
      assertProductionWorkerBootstrapPrecondition(
        templateVersionId,
        wranglerFailure.inspector,
      ),
    ).rejects.not.toThrow("raw sensitive stderr")
    await expect(
      assertProductionWorkerBootstrapPrecondition(
        templateVersionId,
        apiFailure.inspector,
      ),
    ).rejects.not.toThrow("raw api body")
  })
})

describe("production Worker bootstrap postcondition", () => {
  it("accepts this active attempt, its core bindings and Secrets, and the target domain", async () => {
    const harness = createHarness("post")
    await expect(
      assertProductionWorkerBootstrapPostcondition(identity, harness.inspector),
    ).resolves.toBeUndefined()
    expect(harness.calls).toEqual([
      `deployments status --name ${workerName} --json`,
      `versions view ${activeVersionId} --name ${workerName} --json`,
      `secret list --name ${workerName} --format json`,
    ])
    expect(harness.apiRequests).toEqual([
      {
        path: `/accounts/${accountId}/workers/domains?service=${workerName}&environment=production`,
        request: {},
      },
      {
        path: `/accounts/${accountId}/workers/scripts/${workerName}/script-settings`,
        request: {},
      },
    ])
  })

  it("accepts the exact filtered domain when result_info is omitted", async () => {
    const harness = createHarness("post", {
      domains: {
        body: {
          result: [
            {
              environment: "production",
              hostname: "auth.eruoo.me",
              service: workerName,
            },
          ],
          success: true,
        },
        status: 200,
      },
    })

    await expect(
      assertProductionWorkerBootstrapPostcondition(identity, harness.inspector),
    ).resolves.toBeUndefined()
  })

  it.each([
    [
      "another deployment",
      { deployment: { ...activeDeployment(), annotations: {} } },
      "deployment attempt is not active",
    ],
    [
      "a changed binding",
      {
        version: {
          ...activeVersion(),
          resources: {
            ...(activeVersion()["resources"] as Record<string, unknown>),
            bindings: bindings().slice(1),
          },
        },
      },
      "core binding contract",
    ],
    ["a missing Secret", { secrets: secrets().slice(1) }, "Secret manifest"],
    [
      "an outbound Tail Consumer",
      {
        scriptSettings: {
          body: {
            result: {
              logpush: false,
              observability: {
                logs: { enabled: true },
                traces: { enabled: false },
              },
              tail_consumers: [{ service: "external-sink" }],
            },
            success: true,
          },
          status: 200,
        },
      },
      "outbound telemetry remains configured",
    ],
    [
      "an outbound Streaming Tail Consumer",
      {
        scriptSettings: {
          body: {
            result: {
              logpush: false,
              observability: {
                logs: { enabled: true },
                traces: { enabled: false },
              },
              streaming_tail_consumers: [{ service: "external-sink" }],
              tail_consumers: null,
            },
            success: true,
          },
          status: 200,
        },
      },
      "outbound telemetry remains configured",
    ],
    [
      "a mismatched domain hostname",
      {
        domains: {
          body: {
            result: [
              {
                environment: "production",
                hostname: "other.eruoo.me",
                service: workerName,
              },
            ],
            success: true,
          },
          status: 200,
        },
      },
      "target Custom Domain",
    ],
    [
      "a mismatched domain service",
      {
        domains: {
          body: {
            result: [
              {
                environment: "production",
                hostname: "auth.eruoo.me",
                service: "another-worker",
              },
            ],
            success: true,
          },
          status: 200,
        },
      },
      "target Custom Domain",
    ],
    [
      "a mismatched domain environment",
      {
        domains: {
          body: {
            result: [
              {
                environment: "staging",
                hostname: "auth.eruoo.me",
                service: workerName,
              },
            ],
            success: true,
          },
          status: 200,
        },
      },
      "target Custom Domain",
    ],
    [
      "an extra filtered domain",
      {
        domains: {
          body: {
            result: [
              {
                environment: "production",
                hostname: "auth.eruoo.me",
                service: workerName,
              },
              {
                environment: "production",
                hostname: "other.eruoo.me",
                service: workerName,
              },
            ],
            result_info: { total_count: 8 },
            success: true,
          },
          status: 200,
        },
      },
      "target Custom Domain",
    ],
  ])("rejects %s", async (_name, overrides, message) => {
    const harness = createHarness("post", overrides)
    await expect(
      assertProductionWorkerBootstrapPostcondition(identity, harness.inspector),
    ).rejects.toThrow(message)
  })

  it("retries a short eventual-consistency delay", async () => {
    const harness = createHarness("post", {
      deployment: (read: number) =>
        read === 1 ? templateDeployment() : activeDeployment(),
    })
    await expect(
      assertProductionWorkerBootstrapPostcondition(identity, harness.inspector),
    ).resolves.toBeUndefined()
    expect(harness.waits).toEqual([2_000])
  })

  it("fails closed after bounded retries without exposing raw command output", async () => {
    const harness = createHarness("post", { commandFailure: "version" })
    let failure: unknown
    try {
      await assertProductionWorkerBootstrapPostcondition(
        identity,
        harness.inspector,
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("did not converge")
    expect((failure as Error).message).toContain("automatic retry is forbidden")
    expect((failure as Error).message).not.toContain("raw sensitive stderr")
    expect(harness.waits).toHaveLength(4)
  })
})

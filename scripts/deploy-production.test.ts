import { describe, expect, it, vi } from "vitest"

import {
  assertProductionDeployContext,
  createProductionBootstrapDeployCommands,
  createProductionDeployChildEnvironment,
  createProductionGitChildEnvironment,
  createProductionPreflightChildEnvironment,
  formatProductionDeployFailure,
  productionCloudflareAccountId,
  productionDeployCommands,
  resolveProductionDeployContext,
  runProductionDeploy,
  type ProductionDeployCommand,
  type ProductionDeployContext,
  type ProductionDeployDependencies,
} from "./deploy-production"
import type { ProductionWorkerBootstrapIdentity } from "./production-worker-bootstrap"

const commitSha = "a".repeat(40)
const templateVersionId = "11111111-1111-4111-8111-111111111111"

function commandText(command: ProductionDeployCommand): string {
  return `${command.executable} ${command.args.join(" ")}`
}

function validContext(
  overrides: Partial<ProductionDeployContext> = {},
): ProductionDeployContext {
  return {
    bootstrapVersionId: undefined,
    branch: "production",
    checkedOutCommitSha: commitSha,
    cloudflareApiTokenPresent: true,
    commitSha,
    productionBranchCommitSha: commitSha,
    workersCi: "1",
    worktreeStatus: "",
    ...overrides,
  }
}

const bootstrapIdentity: ProductionWorkerBootstrapIdentity = {
  commitSha,
  message: `eruoo-server production bootstrap ${commitSha} bootstrap-attempt`,
  tag: "bootstrap-attempt",
  templateVersionId,
}

function createHarness(
  options: {
    bootstrap?: boolean
    contexts?: ProductionDeployContext[]
    runner?: (command: ProductionDeployCommand) => Promise<void>
  } = {},
) {
  const context = validContext({
    bootstrapVersionId: options.bootstrap ? templateVersionId : undefined,
  })
  const contexts = [...(options.contexts ?? [context])]
  let contextIndex = 0
  const commands: ProductionDeployCommand[] = []
  const runner = vi.fn<(command: ProductionDeployCommand) => Promise<void>>(
    async (command) => {
      commands.push(command)
      await options.runner?.(command)
    },
  )
  const verifyBootstrapPrecondition = vi.fn<
    (templateVersionId: string) => Promise<void>
  >(async () => undefined)
  const verifyBootstrapPostcondition = vi.fn<
    (identity: ProductionWorkerBootstrapIdentity) => Promise<void>
  >(async () => undefined)
  const createBootstrapIdentity = vi.fn<
    (
      templateVersionId: string,
      commitSha: string,
    ) => ProductionWorkerBootstrapIdentity
  >(() => bootstrapIdentity)
  const resolveContext = vi.fn<() => ProductionDeployContext>(
    () => contexts[Math.min(contextIndex++, contexts.length - 1)]!,
  )

  const dependencies: ProductionDeployDependencies = {
    createBootstrapIdentity,
    resolveContext,
    runner,
    verifyBootstrapPostcondition,
    verifyBootstrapPrecondition,
  }

  return {
    commands,
    createBootstrapIdentity,
    dependencies,
    resolveContext,
    runner,
    verifyBootstrapPostcondition,
    verifyBootstrapPrecondition,
  }
}

describe("production deployment commands", () => {
  it("uses preflight, remote D1 migrations, and a strict generated-config deploy", () => {
    expect(productionDeployCommands.map(commandText)).toEqual([
      "pnpm run release:preflight",
      "pnpm exec wrangler d1 migrations apply DB --remote --env production --config wrangler.jsonc --env-file /dev/null",
      "pnpm exec wrangler deploy --config dist/eruoo_server/wrangler.json --env-file /dev/null --no-x-provision --strict",
    ])
  })

  it("removes strict only for the identified one-time bootstrap attempt", () => {
    const commands = createProductionBootstrapDeployCommands(bootstrapIdentity)
    const deploy = commands[2]!

    expect(deploy.args).not.toContain("--strict")
    expect(deploy.args).not.toContain("--keep-vars")
    expect(deploy.args).not.toContain("--force")
    expect(deploy.args).toEqual([
      "exec",
      "wrangler",
      "deploy",
      "--config",
      "dist/eruoo_server/wrangler.json",
      "--env-file",
      "/dev/null",
      "--no-x-provision",
      "--tag",
      bootstrapIdentity.tag,
      "--message",
      bootstrapIdentity.message,
    ])
  })
})

describe("production deployment context", () => {
  it("accepts the exact protected production checkout", () => {
    expect(() => assertProductionDeployContext(validContext())).not.toThrow()
  })

  it.each([
    {
      message: "restricted to Cloudflare Workers Builds",
      override: { workersCi: "0" },
    },
    {
      message: "WORKERS_CI_BRANCH=production",
      override: { branch: "main" },
    },
    {
      message: "valid WORKERS_CI_COMMIT_SHA",
      override: { commitSha: "short" },
    },
    {
      message: "checked-out Git commit",
      override: { checkedOutCommitSha: "short" },
    },
    {
      message: "does not match the checked-out Git commit",
      override: { commitSha: "b".repeat(40) },
    },
    {
      message: "protected remote production branch",
      override: { productionBranchCommitSha: "" },
    },
    {
      message: "does not match the protected remote production branch",
      override: { productionBranchCommitSha: "b".repeat(40) },
    },
    {
      message: "verify the Git worktree state",
      override: { worktreeStatus: undefined },
    },
    {
      message: "clean Git worktree",
      override: { worktreeStatus: "?? generated.txt" },
    },
    {
      message: "non-empty CLOUDFLARE_API_TOKEN",
      override: { cloudflareApiTokenPresent: false },
    },
  ])("rejects $message", ({ message, override }) => {
    expect(() => assertProductionDeployContext(validContext(override))).toThrow(
      message,
    )
  })

  it("resolves HEAD, clean state, and the single exact remote ref", () => {
    const readOutput = vi.fn<(args: readonly string[]) => string | undefined>(
      (args) => {
        if (args[0] === "rev-parse") return commitSha
        if (args[0] === "ls-remote") {
          return `${commitSha}\trefs/heads/production`
        }
        if (args.includes("status")) return ""
        return undefined
      },
    )

    expect(
      resolveProductionDeployContext(
        {
          CLOUDFLARE_API_TOKEN: "token",
          PRODUCTION_WORKER_BOOTSTRAP_VERSION_ID: templateVersionId,
          WORKERS_CI: "1",
          WORKERS_CI_BRANCH: "production",
          WORKERS_CI_COMMIT_SHA: commitSha,
        },
        readOutput,
      ),
    ).toEqual(validContext({ bootstrapVersionId: templateVersionId }))
    expect(readOutput).toHaveBeenCalledWith([
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ])
  })

  it("fails closed when ls-remote returns more than one ref", () => {
    const readOutput = (args: readonly string[]) => {
      if (args[0] === "rev-parse") return commitSha
      if (args[0] === "ls-remote") {
        return `${commitSha}\trefs/heads/production\n${"b".repeat(40)}\trefs/heads/other`
      }
      return ""
    }
    const context = resolveProductionDeployContext(
      {
        CLOUDFLARE_API_TOKEN: "token",
        WORKERS_CI: "1",
        WORKERS_CI_BRANCH: "production",
        WORKERS_CI_COMMIT_SHA: commitSha,
      },
      readOutput,
    )

    expect(() => assertProductionDeployContext(context)).toThrow(
      "protected remote production branch",
    )
  })

  it.each([
    "CF_API_BASE_URL",
    "CLOUDFLARE_API_BASE_URL",
    "WRANGLER_AUTH_DOMAIN",
    "WRANGLER_AUTH_URL",
    "WRANGLER_LOG_PATH",
    "WRANGLER_REVOKE_URL",
    "WRANGLER_TOKEN_URL",
  ] as const)("rejects the %s override", (name) => {
    expect(() =>
      resolveProductionDeployContext(
        {
          [name]: "https://example.invalid",
          CLOUDFLARE_API_TOKEN: "token",
          WORKERS_CI: "1",
          WORKERS_CI_BRANCH: "production",
          WORKERS_CI_COMMIT_SHA: commitSha,
        },
        () => "",
      ),
    ).toThrow(`forbids the ${name} override`)
  })

  it.each([
    ["CLOUDFLARE_ACCOUNT_ID", "another-account"],
    ["CF_ACCOUNT_ID", "another-account"],
    ["CLOUDFLARE_COMPLIANCE_REGION", "eu"],
    ["WRANGLER_API_ENVIRONMENT", "staging"],
    ["WRANGLER_CI_GENERATE_PREVIEW_ALIAS", "true"],
    ["WRANGLER_CI_OVERRIDE_NAME", "another-worker"],
    ["WRANGLER_WRITE_LOGS", "true"],
  ] as const)("rejects %s=%s", (name, value) => {
    expect(() =>
      resolveProductionDeployContext(
        {
          [name]: value,
          CLOUDFLARE_API_TOKEN: "token",
          WORKERS_CI: "1",
          WORKERS_CI_BRANCH: "production",
          WORKERS_CI_COMMIT_SHA: commitSha,
        },
        () => "",
      ),
    ).toThrow(`rejects ${name}`)
  })
})

describe("production child environments", () => {
  const source = {
    CLOUDFLARE_API_TOKEN: "secret-token",
    CF_API_BASE_URL: "https://example.invalid",
    GIT_DIR: "/tmp/fake-git",
    HTTPS_PROXY: "http://proxy.example.invalid",
    PATH: "/usr/bin",
    WRANGLER_CI_MATCH_TAG: "match-tag",
    WRANGLER_LOG_PATH: "/tmp/wrangler.log",
  }

  it("scrubs Git and Cloudflare credentials while retaining normal tooling", () => {
    const environment = createProductionGitChildEnvironment(source)

    expect(environment["CLOUDFLARE_API_TOKEN"]).toBeUndefined()
    expect(environment["CF_API_BASE_URL"]).toBeUndefined()
    expect(environment["GIT_DIR"]).toBeUndefined()
    expect(environment["WRANGLER_CI_MATCH_TAG"]).toBeUndefined()
    expect(environment["PATH"]).toBe("/usr/bin")
    expect(environment["HTTPS_PROXY"]).toBe("http://proxy.example.invalid")
    expect(environment["GIT_CONFIG_GLOBAL"]).toBe("/dev/null")
    expect(environment["GIT_CONFIG_NOSYSTEM"]).toBe("1")
  })

  it("keeps the preflight token-free", () => {
    const environment = createProductionPreflightChildEnvironment(source)

    expect(environment["CLOUDFLARE_API_TOKEN"]).toBeUndefined()
    expect(environment["WRANGLER_LOG_PATH"]).toBeUndefined()
    expect(environment["WRANGLER_CI_OVERRIDE_NAME"]).toBe(
      "eruoo-server-production",
    )
    expect(environment["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV"]).toBe("false")
  })

  it("gives only the frozen production identity and token to write commands", () => {
    const environment = createProductionDeployChildEnvironment(source)

    expect(environment["CLOUDFLARE_API_TOKEN"]).toBe("secret-token")
    expect(environment["CLOUDFLARE_ACCOUNT_ID"]).toBe(
      productionCloudflareAccountId,
    )
    expect(environment["CLOUDFLARE_COMPLIANCE_REGION"]).toBe("public")
    expect(environment["WRANGLER_CI_MATCH_TAG"]).toBe("match-tag")
    expect(environment["WRANGLER_LOG_PATH"]).toBeUndefined()
  })

  it.each([undefined, "", "  "])(
    "rejects a missing write token: %s",
    (token) => {
      expect(() =>
        createProductionDeployChildEnvironment({
          CLOUDFLARE_API_TOKEN: token,
        }),
      ).toThrow("non-empty CLOUDFLARE_API_TOKEN")
    },
  )
})

describe("production deployment orchestration", () => {
  it("runs the normal strict release in fixed order", async () => {
    const harness = createHarness()

    await runProductionDeploy(harness.dependencies)

    expect(harness.commands.map(commandText)).toEqual(
      productionDeployCommands.map(commandText),
    )
    expect(harness.verifyBootstrapPrecondition).not.toHaveBeenCalled()
    expect(harness.verifyBootstrapPostcondition).not.toHaveBeenCalled()
  })

  it("checks the bootstrap baseline before migration and again before upload", async () => {
    const harness = createHarness({ bootstrap: true })

    await runProductionDeploy(harness.dependencies)

    expect(harness.createBootstrapIdentity).toHaveBeenCalledWith(
      templateVersionId,
      commitSha,
    )
    expect(harness.verifyBootstrapPrecondition).toHaveBeenCalledTimes(2)
    expect(harness.verifyBootstrapPrecondition).toHaveBeenCalledWith(
      templateVersionId,
    )
    expect(harness.verifyBootstrapPostcondition).toHaveBeenCalledOnce()
    expect(harness.commands[2]?.args).not.toContain("--strict")
    expect(harness.commands[2]?.args).toContain(bootstrapIdentity.tag)
  })

  it("does not inspect or write remote state when preflight fails", async () => {
    const harness = createHarness({
      bootstrap: true,
      runner: async (command) => {
        if (command === productionDeployCommands[0]) {
          throw new Error("preflight failed")
        }
      },
    })

    await expect(runProductionDeploy(harness.dependencies)).rejects.toThrow(
      "preflight failed",
    )
    expect(harness.commands).toHaveLength(1)
    expect(harness.verifyBootstrapPrecondition).not.toHaveBeenCalled()
  })

  it("stops before migration when the initial bootstrap baseline is wrong", async () => {
    const harness = createHarness({ bootstrap: true })
    harness.verifyBootstrapPrecondition.mockRejectedValueOnce(
      new Error("template changed"),
    )

    await expect(runProductionDeploy(harness.dependencies)).rejects.toThrow(
      "template changed",
    )
    expect(harness.commands.map(commandText)).toEqual([
      commandText(productionDeployCommands[0]),
    ])
  })

  it("classifies migration failure as a possible partial remote write", async () => {
    const harness = createHarness({
      runner: async (command) => {
        if (command === productionDeployCommands[1]) {
          throw new Error("migration failed")
        }
      },
    })

    const failure = await runProductionDeploy(harness.dependencies).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect(formatProductionDeployFailure(failure)).toContain(
      "remote schema may already be partially applied; automatic retry is forbidden",
    )
    expect(formatProductionDeployFailure(failure)).toContain(
      "- migration failed",
    )
    expect(harness.commands).toHaveLength(2)
  })

  it("does not upload when context changes after migration", async () => {
    const harness = createHarness({
      contexts: [
        validContext(),
        validContext(),
        validContext({ productionBranchCommitSha: "b".repeat(40) }),
      ],
    })

    await expect(runProductionDeploy(harness.dependencies)).rejects.toThrow(
      "remote schema may already be applied",
    )
    expect(harness.commands).toHaveLength(2)
  })

  it("does not upload when the second bootstrap check fails", async () => {
    const harness = createHarness({ bootstrap: true })
    harness.verifyBootstrapPrecondition
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("baseline changed"))

    const failure = await runProductionDeploy(harness.dependencies).catch(
      (error: unknown) => error,
    )
    expect(formatProductionDeployFailure(failure)).toContain(
      "remote schema may already be applied",
    )
    expect(formatProductionDeployFailure(failure)).toContain(
      "- baseline changed",
    )
    expect(harness.commands).toHaveLength(2)
  })

  it("still reconciles bootstrap state after the upload command fails", async () => {
    const harness = createHarness({
      bootstrap: true,
      runner: async (command) => {
        if (command.args.includes("deploy")) throw new Error("upload failed")
      },
    })

    const failure = await runProductionDeploy(harness.dependencies).catch(
      (error: unknown) => error,
    )
    expect(harness.verifyBootstrapPostcondition).toHaveBeenCalledOnce()
    expect(formatProductionDeployFailure(failure)).toContain(
      "Remote Worker state may already be applied; automatic retry is forbidden",
    )
    expect(formatProductionDeployFailure(failure)).toContain("- upload failed")
  })

  it("aggregates upload, bootstrap reconciliation, and final context failures", async () => {
    const dirtyContext = validContext({
      bootstrapVersionId: templateVersionId,
      worktreeStatus: " M changed.ts",
    })
    const harness = createHarness({
      bootstrap: true,
      contexts: [
        validContext({ bootstrapVersionId: templateVersionId }),
        validContext({ bootstrapVersionId: templateVersionId }),
        validContext({ bootstrapVersionId: templateVersionId }),
        validContext({ bootstrapVersionId: templateVersionId }),
        validContext({ bootstrapVersionId: templateVersionId }),
        dirtyContext,
      ],
      runner: async (command) => {
        if (command.args.includes("deploy")) throw new Error("upload failed")
      },
    })
    harness.verifyBootstrapPostcondition.mockRejectedValueOnce(
      new Error("postcondition failed"),
    )

    const failure = await runProductionDeploy(harness.dependencies).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(3)
    expect(formatProductionDeployFailure(failure)).toContain("- upload failed")
    expect(formatProductionDeployFailure(failure)).toContain(
      "- postcondition failed",
    )
    expect(formatProductionDeployFailure(failure)).toContain(
      "- Production deployment requires a clean Git worktree.",
    )
  })

  it("rejects bootstrap mode changes before any remote write", async () => {
    const harness = createHarness({
      bootstrap: true,
      contexts: [
        validContext({ bootstrapVersionId: templateVersionId }),
        validContext({ bootstrapVersionId: undefined }),
      ],
    })

    await expect(runProductionDeploy(harness.dependencies)).rejects.toThrow(
      "bootstrap mode changed",
    )
    expect(harness.commands).toHaveLength(1)
  })
})

describe("production failure formatting", () => {
  it("formats direct and aggregate failures without recursively exposing causes", () => {
    expect(formatProductionDeployFailure(new Error("direct failure"))).toBe(
      "direct failure",
    )
    expect(
      formatProductionDeployFailure(
        new AggregateError(
          [new Error("first"), new Error("second")],
          "multiple failures",
        ),
      ),
    ).toBe("multiple failures\n- first\n- second")
    expect(formatProductionDeployFailure("unknown")).toBe(
      "Production deployment failed without a classified error.",
    )
  })
})

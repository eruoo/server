import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import {
  createProductionMigrationGitChildEnvironment,
  readProductionMigrationBaseline,
  readProductionMigrationFileState,
  resolveProductionMigrationBaselineCommitSha,
} from "./migration-history"
import { validateProductionMigrationChecksums } from "./release-preflight-validation"

const foundationSql = "CREATE TABLE foundation (id INTEGER PRIMARY KEY);\n"
const expandSql = "ALTER TABLE foundation ADD COLUMN name TEXT;\n"
const temporaryDirectories: string[] = []

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}

function runGit(repositoryDirectory: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim()
}

function commitAll(repositoryDirectory: string, message: string): void {
  runGit(repositoryDirectory, ["add", "--all"])
  runGit(repositoryDirectory, ["commit", "--message", message])
}

async function createRepository(): Promise<string> {
  const repositoryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "eruoo-migration-history-test-"),
  )
  temporaryDirectories.push(repositoryDirectory)
  runGit(repositoryDirectory, ["init", "--initial-branch=main"])
  runGit(repositoryDirectory, ["config", "user.name", "Migration Test"])
  runGit(repositoryDirectory, [
    "config",
    "user.email",
    "migration-test@example.invalid",
  ])
  runGit(repositoryDirectory, ["config", "commit.gpgSign", "false"])
  await mkdir(path.join(repositoryDirectory, "migrations"))
  await writeFile(
    path.join(repositoryDirectory, "migrations/0001_foundation.sql"),
    foundationSql,
  )
  commitAll(repositoryDirectory, "add foundation migration")
  return repositoryDirectory
}

async function addFollowUpCommit(
  repositoryDirectory: string,
  marker = "follow-up",
): Promise<void> {
  await writeFile(
    path.join(repositoryDirectory, `${marker}.txt`),
    `${marker}\n`,
  )
  commitAll(repositoryDirectory, `add ${marker}`)
}

async function createShallowClone(
  sourceRepositoryDirectory: string,
  depth = 1,
): Promise<string> {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "eruoo-migration-shallow-test-"),
  )
  temporaryDirectories.push(fixtureRoot)
  const cloneDirectory = path.join(fixtureRoot, "shallow")
  execFileSync(
    "git",
    [
      "clone",
      "--branch",
      "main",
      `--depth=${depth}`,
      pathToFileURL(sourceRepositoryDirectory).href,
      cloneDirectory,
    ],
    { stdio: "ignore", timeout: 10_000 },
  )
  return cloneDirectory
}

function readAuthoritativeMigrationFailures(
  repositoryDirectory: string,
  productionBaselineSha: string,
): string[] {
  const baseline = readProductionMigrationBaseline({
    cwd: repositoryDirectory,
    environment: {
      GITHUB_ACTIONS: "true",
      PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
    },
  })
  const current = readProductionMigrationFileState({
    cwd: repositoryDirectory,
    migrationDirectory: "migrations",
  })
  return [
    ...current.failures,
    ...validateProductionMigrationChecksums({
      actualChecksums: current.checksums,
      baselineChecksums: baseline.checksums,
    }),
  ]
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

it("isolates migration Git commands from Cloudflare, Wrangler, and Git overrides", () => {
  expect(
    createProductionMigrationGitChildEnvironment({
      CF_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "production-token",
      EXISTING: "preserved",
      GIT_DIR: "/tmp/another-repository",
      HTTPS_PROXY: "http://proxy.example",
      WRANGLER_CI_MATCH_TAG: "worker-build-match-tag",
    }),
  ).toEqual({
    EXISTING: "preserved",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    HTTPS_PROXY: "http://proxy.example",
  })
})

describe("current production migration files", () => {
  it("hashes the approved regular migrations", async () => {
    const repositoryDirectory = await createRepository()

    expect(
      readProductionMigrationFileState({
        cwd: repositoryDirectory,
        migrationDirectory: "./migrations",
      }),
    ).toEqual({
      checksums: { "0001_foundation.sql": checksum(foundationSql) },
      failures: [],
    })
  })

  it("rejects invalid names and unexpected entries", async () => {
    const repositoryDirectory = await createRepository()
    await writeFile(
      path.join(repositoryDirectory, "migrations/2_BAD.sql"),
      expandSql,
    )
    await writeFile(
      path.join(repositoryDirectory, "migrations/notes.txt"),
      "note\n",
    )
    await mkdir(path.join(repositoryDirectory, "migrations/nested"))

    const state = readProductionMigrationFileState({
      cwd: repositoryDirectory,
      migrationDirectory: "migrations",
    })
    expect(state.checksums).toEqual({
      "0001_foundation.sql": checksum(foundationSql),
    })
    expect(state.failures).toEqual([
      "Production migration 2_BAD.sql must use the approved four-digit filename format.",
      "Production migration entry nested must be a regular non-executable file.",
      "Production migration notes.txt must use the approved four-digit filename format.",
    ])
  })

  it("rejects symlinked, executable, and out-of-repository inputs", async () => {
    const repositoryDirectory = await createRepository()
    await writeFile(path.join(repositoryDirectory, "outside.sql"), expandSql)
    await symlink(
      path.join(repositoryDirectory, "outside.sql"),
      path.join(repositoryDirectory, "migrations/0002_expand.sql"),
    )
    await chmod(
      path.join(repositoryDirectory, "migrations/0001_foundation.sql"),
      0o755,
    )

    expect(
      readProductionMigrationFileState({
        cwd: repositoryDirectory,
        migrationDirectory: "migrations",
      }).failures,
    ).toEqual([
      "Production migration entry 0001_foundation.sql must be a regular non-executable file.",
      "Production migration entry 0002_expand.sql must be a regular non-executable file.",
    ])
    expect(
      readProductionMigrationFileState({
        cwd: repositoryDirectory,
        migrationDirectory: "../migrations",
      }).failures,
    ).toEqual([
      "The production migration directory must stay inside the repository.",
    ])
  })

  it("rejects a symlinked migration directory", async () => {
    const repositoryDirectory = await createRepository()
    await mkdir(path.join(repositoryDirectory, "actual-migrations"))
    await symlink(
      path.join(repositoryDirectory, "actual-migrations"),
      path.join(repositoryDirectory, "linked-migrations"),
    )

    expect(
      readProductionMigrationFileState({
        cwd: repositoryDirectory,
        migrationDirectory: "linked-migrations",
      }).failures,
    ).toEqual([
      "Production migration directory linked-migrations must be a real directory.",
    ])
  })
})

describe("trusted production migration baseline", () => {
  it("reserves the explicit production baseline for GitHub Actions", () => {
    const baselineSha = "a".repeat(40)

    expect(resolveProductionMigrationBaselineCommitSha({})).toBeUndefined()
    expect(() =>
      resolveProductionMigrationBaselineCommitSha({
        PRODUCTION_MIGRATION_BASELINE_SHA: baselineSha,
      }),
    ).toThrow("reserved for GitHub Actions")
    expect(() =>
      resolveProductionMigrationBaselineCommitSha({
        GITHUB_ACTIONS: "true",
        PRODUCTION_MIGRATION_BASELINE_SHA: baselineSha,
        WORKERS_CI: "1",
      }),
    ).toThrow("forbidden in Cloudflare Workers Builds")
    expect(() =>
      resolveProductionMigrationBaselineCommitSha({ GITHUB_ACTIONS: "true" }),
    ).toThrow("must provide PRODUCTION_MIGRATION_BASELINE_SHA")
    expect(() =>
      resolveProductionMigrationBaselineCommitSha({
        GITHUB_ACTIONS: "true",
        PRODUCTION_MIGRATION_BASELINE_SHA: "A".repeat(40),
      }),
    ).toThrow("lowercase nonzero 40-character commit SHA")
    expect(() =>
      resolveProductionMigrationBaselineCommitSha({
        GITHUB_ACTIONS: "true",
        PRODUCTION_MIGRATION_BASELINE_SHA: "0".repeat(40),
      }),
    ).toThrow("lowercase nonzero 40-character commit SHA")
    expect(
      resolveProductionMigrationBaselineCommitSha({
        GITHUB_ACTIONS: "true",
        PRODUCTION_MIGRATION_BASELINE_SHA: baselineSha,
      }),
    ).toBe(baselineSha)
  })

  it("uses the direct parent for non-authoritative local validation", async () => {
    const repositoryDirectory = await createRepository()
    await writeFile(
      path.join(repositoryDirectory, "migrations/0002_expand.sql"),
      expandSql,
    )
    commitAll(repositoryDirectory, "add expand migration")

    expect(
      readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {},
      }),
    ).toEqual({
      checksums: { "0001_foundation.sql": checksum(foundationSql) },
      firstParentCommitSha: runGit(repositoryDirectory, ["rev-parse", "HEAD^"]),
      kind: "available",
      source: "first-parent",
    })
  })

  it("distinguishes a root commit from an unavailable shallow parent", async () => {
    const rootRepository = await createRepository()
    expect(
      readProductionMigrationBaseline({
        cwd: rootRepository,
        environment: {},
      }),
    ).toEqual({
      checksums: {},
      kind: "root",
    })

    await addFollowUpCommit(rootRepository)
    const shallowRepository = await createShallowClone(rootRepository)
    const shallowBaseline = readProductionMigrationBaseline({
      cwd: shallowRepository,
      environment: {},
    })
    expect(shallowBaseline).toMatchObject({
      checksums: {},
      kind: "unavailable",
    })
    expect(
      shallowBaseline.kind === "unavailable"
        ? shallowBaseline.warning
        : undefined,
    ).toContain("shallow checkout")
  })

  it("uses the protected production baseline across multiple candidate commits", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    await writeFile(
      path.join(repositoryDirectory, "migrations/0001_foundation.sql"),
      `${foundationSql}-- changed\n`,
    )
    commitAll(repositoryDirectory, "rewrite migration history")
    await addFollowUpCommit(repositoryDirectory)

    const baseline = readProductionMigrationBaseline({
      cwd: repositoryDirectory,
      environment: {
        GITHUB_ACTIONS: "true",
        PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
      },
    })
    expect(baseline).toMatchObject({
      kind: "available",
      productionCommitSha: productionBaselineSha,
      source: "production-and-candidate-first-parent-history",
    })
    expect(
      validateProductionMigrationChecksums({
        actualChecksums: readProductionMigrationFileState({
          cwd: repositoryDirectory,
          migrationDirectory: "migrations",
        }).checksums,
        baselineChecksums: baseline.checksums,
      }),
    ).toContain(
      "Production migration 0001_foundation.sql must remain byte-for-byte identical to its trusted Git baseline.",
    )
  })

  it.each(["rewritten", "deleted", "renamed"] as const)(
    "rejects a pending migration that was $action before a later candidate",
    async (action) => {
      const repositoryDirectory = await createRepository()
      const productionBaselineSha = runGit(repositoryDirectory, [
        "rev-parse",
        "HEAD",
      ])
      const migrationPath = path.join(
        repositoryDirectory,
        "migrations/0002_expand.sql",
      )
      await writeFile(migrationPath, expandSql)
      commitAll(repositoryDirectory, "add pending production migration")

      if (action === "rewritten") {
        await writeFile(migrationPath, `${expandSql}-- changed\n`)
      } else if (action === "deleted") {
        await rm(migrationPath)
      } else {
        await rename(
          migrationPath,
          path.join(repositoryDirectory, "migrations/0002_renamed.sql"),
        )
      }
      commitAll(repositoryDirectory, `${action} pending production migration`)
      await addFollowUpCommit(repositoryDirectory)

      expect(
        readAuthoritativeMigrationFailures(
          repositoryDirectory,
          productionBaselineSha,
        ),
      ).toContain(
        "Production migration 0002_expand.sql must remain byte-for-byte identical to its trusted Git baseline.",
      )
    },
  )

  it("accepts append-only migrations across multiple candidate commits", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    await writeFile(
      path.join(repositoryDirectory, "migrations/0002_expand.sql"),
      expandSql,
    )
    commitAll(repositoryDirectory, "add expand migration")
    await writeFile(
      path.join(repositoryDirectory, "migrations/0003_index.sql"),
      "CREATE INDEX foundation_name_idx ON foundation(name);\n",
    )
    commitAll(repositoryDirectory, "add index migration")
    await addFollowUpCommit(repositoryDirectory)

    expect(
      readAuthoritativeMigrationFailures(
        repositoryDirectory,
        productionBaselineSha,
      ),
    ).toEqual([])
  })

  it("rejects a back-numbered migration hidden by a later candidate", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    await writeFile(
      path.join(repositoryDirectory, "migrations/0003_later.sql"),
      expandSql,
    )
    commitAll(repositoryDirectory, "add later migration")
    await writeFile(
      path.join(repositoryDirectory, "migrations/0002_backfill.sql"),
      "SELECT 1;\n",
    )
    commitAll(repositoryDirectory, "backfill an earlier sequence")
    await addFollowUpCommit(repositoryDirectory)

    expect(
      readAuthoritativeMigrationFailures(
        repositoryDirectory,
        productionBaselineSha,
      ),
    ).toContain(
      "New production migration 0002_backfill.sql must use a sequence greater than the trusted baseline maximum 0003.",
    )
  })

  it("allows a later candidate to restore the last valid migration state", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    const migrationPath = path.join(
      repositoryDirectory,
      "migrations/0002_expand.sql",
    )
    await writeFile(migrationPath, expandSql)
    commitAll(repositoryDirectory, "add pending production migration")
    await writeFile(migrationPath, `${expandSql}-- invalid rewrite\n`)
    commitAll(repositoryDirectory, "rewrite pending production migration")
    await writeFile(migrationPath, expandSql)
    commitAll(repositoryDirectory, "restore pending production migration")

    expect(
      readAuthoritativeMigrationFailures(
        repositoryDirectory,
        productionBaselineSha,
      ),
    ).toEqual([])
  })

  it("treats Workers Builds migration history validation as non-authoritative", async () => {
    const repositoryDirectory = await createRepository()

    const baseline = readProductionMigrationBaseline({
      cwd: repositoryDirectory,
      environment: { WORKERS_CI: "1" },
    })

    expect(baseline).toMatchObject({
      checksums: {},
      kind: "unavailable",
      source: "workers-build",
    })
    expect(
      baseline.kind === "unavailable" ? baseline.warning : undefined,
    ).toContain(
      "authoritative production-history gate inside the GitHub Actions check job",
    )
  })

  it("accepts production when it already equals the candidate commit", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])

    expect(
      readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {
          GITHUB_ACTIONS: "true",
          PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
        },
      }),
    ).toEqual({
      checksums: { "0001_foundation.sql": checksum(foundationSql) },
      kind: "available",
      productionCommitSha: productionBaselineSha,
      source: "production-and-candidate-first-parent-history",
    })
  })

  it("fails closed when the explicit production commit is unavailable", async () => {
    const repositoryDirectory = await createRepository()

    expect(() =>
      readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {
          GITHUB_ACTIONS: "true",
          PRODUCTION_MIGRATION_BASELINE_SHA: "a".repeat(40),
        },
      }),
    ).toThrow("Unable to read the trusted production migration baseline commit")
  })

  it("fails closed when the candidate first-parent history is incomplete", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    await addFollowUpCommit(repositoryDirectory, "candidate-one")
    await addFollowUpCommit(repositoryDirectory, "candidate-two")
    await addFollowUpCommit(repositoryDirectory, "candidate-three")
    const shallowRepository = await createShallowClone(repositoryDirectory, 2)
    runGit(shallowRepository, [
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      productionBaselineSha,
    ])
    runGit(shallowRepository, [
      "cat-file",
      "-e",
      `${productionBaselineSha}^{commit}`,
    ])

    expect(() =>
      readProductionMigrationBaseline({
        cwd: shallowRepository,
        environment: {
          GITHUB_ACTIONS: "true",
          PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
        },
      }),
    ).toThrow("must be a readable first-parent ancestor of the release commit")
  })

  it("fails closed when production is not a candidate ancestor", async () => {
    const repositoryDirectory = await createRepository()
    runGit(repositoryDirectory, ["switch", "-c", "production-fixture"])
    await addFollowUpCommit(repositoryDirectory, "production-only")
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    runGit(repositoryDirectory, ["switch", "main"])
    await addFollowUpCommit(repositoryDirectory, "candidate-only")

    expect(() =>
      readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {
          GITHUB_ACTIONS: "true",
          PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
        },
      }),
    ).toThrow("must be a readable first-parent ancestor of the release commit")
  })

  it("fails closed when production is only a second-parent ancestor", async () => {
    const repositoryDirectory = await createRepository()
    runGit(repositoryDirectory, ["switch", "-c", "production-fixture"])
    await addFollowUpCommit(repositoryDirectory, "production-only")
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    runGit(repositoryDirectory, ["switch", "main"])
    await addFollowUpCommit(repositoryDirectory, "candidate-only")
    runGit(repositoryDirectory, [
      "merge",
      "--no-ff",
      "--no-commit",
      "production-fixture",
    ])
    commitAll(repositoryDirectory, "merge production as a second parent")

    expect(() =>
      readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {
          GITHUB_ACTIONS: "true",
          PRODUCTION_MIGRATION_BASELINE_SHA: productionBaselineSha,
        },
      }),
    ).toThrow("must be a readable first-parent ancestor of the release commit")
  })

  it("accepts a synthetic PR merge without freezing second-parent commits", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    await addFollowUpCommit(repositoryDirectory, "main-base")
    runGit(repositoryDirectory, ["switch", "-c", "feature"])
    const migrationPath = path.join(
      repositoryDirectory,
      "migrations/0002_expand.sql",
    )
    await writeFile(migrationPath, `${expandSql}-- first draft\n`)
    commitAll(repositoryDirectory, "draft migration")
    await writeFile(migrationPath, expandSql)
    commitAll(repositoryDirectory, "finish migration")
    runGit(repositoryDirectory, ["switch", "main"])
    runGit(repositoryDirectory, ["merge", "--no-ff", "--no-commit", "feature"])
    commitAll(repositoryDirectory, "create synthetic PR merge")

    expect(
      readAuthoritativeMigrationFailures(
        repositoryDirectory,
        productionBaselineSha,
      ),
    ).toEqual([])
  })

  it("rejects washed migration history beneath a synthetic PR merge", async () => {
    const repositoryDirectory = await createRepository()
    const productionBaselineSha = runGit(repositoryDirectory, [
      "rev-parse",
      "HEAD",
    ])
    const migrationPath = path.join(
      repositoryDirectory,
      "migrations/0002_expand.sql",
    )
    await writeFile(migrationPath, expandSql)
    commitAll(repositoryDirectory, "add pending production migration")
    await writeFile(migrationPath, `${expandSql}-- invalid rewrite\n`)
    commitAll(repositoryDirectory, "rewrite pending production migration")
    await addFollowUpCommit(repositoryDirectory, "main-after-rewrite")

    runGit(repositoryDirectory, ["switch", "-c", "feature"])
    await addFollowUpCommit(repositoryDirectory, "feature-only")
    runGit(repositoryDirectory, ["switch", "main"])
    runGit(repositoryDirectory, ["merge", "--no-ff", "--no-commit", "feature"])
    commitAll(repositoryDirectory, "create synthetic PR merge")

    expect(
      readAuthoritativeMigrationFailures(
        repositoryDirectory,
        productionBaselineSha,
      ),
    ).toContain(
      "Production migration 0002_expand.sql must remain byte-for-byte identical to its trusted Git baseline.",
    )
  })

  it.each([
    { action: "changed", removeOldMigration: false },
    { action: "deleted", removeOldMigration: true },
  ])(
    "rejects an old migration that was $action",
    async ({ removeOldMigration }) => {
      const repositoryDirectory = await createRepository()
      const migrationPath = path.join(
        repositoryDirectory,
        "migrations/0001_foundation.sql",
      )
      if (removeOldMigration) {
        await rm(migrationPath)
      } else {
        await writeFile(migrationPath, `${foundationSql}-- changed\n`)
      }
      commitAll(repositoryDirectory, "rewrite migration history")

      const current = readProductionMigrationFileState({
        cwd: repositoryDirectory,
        migrationDirectory: "migrations",
      })
      const baseline = readProductionMigrationBaseline({
        cwd: repositoryDirectory,
        environment: {},
      })
      expect(
        validateProductionMigrationChecksums({
          actualChecksums: current.checksums,
          baselineChecksums: baseline.checksums,
        }),
      ).toContain(
        "Production migration 0001_foundation.sql must remain byte-for-byte identical to its trusted Git baseline.",
      )
    },
  )
})

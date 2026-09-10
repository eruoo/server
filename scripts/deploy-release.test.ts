import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  spawnSync:
    vi.fn<
      (command: string, args: string[], options: unknown) => { status: number }
    >(),
  readFile: vi.fn<(filename: string, encoding?: string) => Promise<string>>(),
  verifyArtifact:
    vi.fn<
      (
        ...args: string[]
      ) => Promise<{ repository: string; config: string; wrangler: string }>
    >(),
}))
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }))
vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  appendFile: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock("./lib/release-artifact", () => ({
  verifyArtifact: mocks.verifyArtifact,
}))
const accountId = "a".repeat(32)
const databaseId = "11111111-1111-4111-8111-111111111111"
const sha = "b".repeat(40)
const secrets = [
  "BETTER_AUTH_SECRETS",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AUDIT_IP_HASH_SECRET",
  "D1_EXPORT_API_TOKEN",
]
const stagingConfig = {
  name: "eruoo-server-staging",
  vars: {
    CF_ACCOUNT_ID: accountId,
    APP_ORIGIN: "https://eruoo-server-staging.l709937065.workers.dev",
    RELEASE_SHA: sha,
    D1_DATABASE_ID: databaseId,
    RELEASE_MIGRATIONS: JSON.stringify({
      "0001_foundation.sql": "c".repeat(64),
    }),
  },
  d1_databases: [
    {
      binding: "DB",
      database_id: databaseId,
      database_name: "eruoo-server-staging",
    },
  ],
  r2_buckets: [
    { binding: "BACKUPS", bucket_name: "eruoo-server-backups-staging" },
  ],
  assets: { binding: "ASSETS" },
  workflows: [
    {
      binding: "DATABASE_BACKUP_WORKFLOW",
      name: "eruoo-database-backup-staging",
      class_name: "DatabaseBackupWorkflow",
    },
  ],
  ratelimits: [
    { name: "AUTH_RATE_LIMITER", simple: { limit: 10, period: 60 } },
    { name: "API_KEY_RATE_LIMITER", simple: { limit: 5, period: 60 } },
  ],
  triggers: { crons: ["0 19 * * *", "0 20 * * *"] },
  secrets: { required: secrets },
}
let config: typeof stagingConfig
let db: DatabaseSync
let deployed = false
let failDeploy = true
let priorDatabaseId: string | undefined
const argv = process.argv
beforeEach(() => {
  config = structuredClone(stagingConfig)
  db = new DatabaseSync(":memory:")
  deployed = false
  failDeploy = true
  priorDatabaseId = undefined
  vi.resetAllMocks()
  process.argv = ["node", "script", "/artifact", "staging", sha, "123"]
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: "eruoo/server",
    GITHUB_REF: "refs/heads/main",
    CLOUDFLARE_API_TOKEN: "synthetic",
    CLOUDFLARE_ACCOUNT_ID: accountId,
  }))
    vi.stubEnv(key, value)
  mocks.verifyArtifact.mockResolvedValue({
    repository: "eruoo/server",
    config: "config.json",
    wrangler: "4.124.0",
  })
  mocks.readFile.mockImplementation(async (filename: string) =>
    JSON.stringify(
      filename.endsWith("package.json") ? { version: "4.124.0" } : config,
    ),
  )
  mocks.spawnSync.mockImplementation((_command: string, args: string[]) => {
    if (args.includes("migrations")) {
      db.exec(
        "CREATE TABLE user(id TEXT); CREATE TABLE d1_migrations(id INTEGER, name TEXT); INSERT INTO d1_migrations VALUES (1,'0001_foundation.sql');",
      )
      return { status: 0 }
    }
    if (failDeploy) return { status: 1 }
    deployed = true
    return { status: 0 }
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith("https://api.cloudflare.com/")) {
        const route = new URL(url).pathname
        return Response.json(
          route === "/health"
            ? { version: "version-1" }
            : route === "/api/auth/get-session"
              ? null
              : {},
          {
            status:
              route === "/api/status" || route === "/api/openapi.json"
                ? 401
                : route.includes("unknown-release")
                  ? 404
                  : 200,
          },
        )
      }
      let result: unknown
      if (url.endsWith("/query")) {
        const body = JSON.parse(String(init?.body)) as {
          sql: string
          params?: string[]
        }
        result = [{ results: db.prepare(body.sql).all(...(body.params ?? [])) }]
      } else if (url.endsWith("/settings"))
        result = {
          bindings: [
            ...secrets.map((name) => ({ name, type: "secret_text" })),
            ...(priorDatabaseId && !deployed
              ? [
                  { name: "DB", id: priorDatabaseId },
                  {
                    name: "RELEASE_MIGRATIONS",
                    text: config.vars.RELEASE_MIGRATIONS,
                  },
                ]
              : []),
            ...(deployed
              ? [
                  ...Object.entries(config.vars).map(([name, text]) => ({
                    name,
                    text,
                    type: "plain_text",
                  })),
                  { name: "DB", id: databaseId },
                  {
                    name: "BACKUPS",
                    bucket_name: config.r2_buckets[0]!.bucket_name,
                  },
                  { name: "ASSETS", type: "assets" },
                  {
                    name: "DATABASE_BACKUP_WORKFLOW",
                    workflow_name: config.workflows[0]!.name,
                  },
                  ...config.ratelimits,
                ]
              : []),
          ],
        }
      else if (url.endsWith("/schedules"))
        result = { schedules: config.triggers.crons.map((cron) => ({ cron })) }
      else if (url.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: "release-1",
              versions: [{ version_id: "version-1", percentage: 100 }],
            },
          ],
        }
      else if (url.endsWith("/domains/managed")) result = { enabled: false }
      else if (url.endsWith("/domains/custom")) result = { domains: [] }
      else if (url.endsWith("/lifecycle"))
        result = {
          rules: [
            {
              id: "daily",
              enabled: true,
              conditions: { prefix: "d1/daily/" },
              deleteObjectsTransition: {
                condition: { type: "Age", maxAge: 2592000 },
              },
            },
          ],
        }
      else if (url.includes("/d1/database/"))
        result = {
          uuid: databaseId,
          name: config.d1_databases[0]!.database_name,
        }
      else if (url.includes("/r2/buckets/"))
        result = { name: config.r2_buckets[0]!.bucket_name }
      else throw new Error("Unexpected request")
      return Response.json({ success: true, result })
    }),
  )
})
afterEach(() => {
  db.close()
  process.argv = argv
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
async function deploy() {
  vi.resetModules()
  await import("./deploy-release")
}
function selectEnvironment(environment: "staging" | "production") {
  process.argv[3] = environment
  if (environment === "production") {
    config.name = "eruoo-server-production"
    config.vars.APP_ORIGIN = "https://auth.eruoo.me"
    config.d1_databases[0]!.database_name = "eruoo-server"
    config.r2_buckets[0]!.bucket_name = "eruoo-server-backups"
    config.workflows[0]!.name = "eruoo-database-backup"
    vi.stubEnv("GITHUB_ACTOR_ID", "50254496")
    vi.stubEnv("GITHUB_ACTOR", "LoTwT")
    vi.stubEnv("GITHUB_TRIGGERING_ACTOR", "LoTwT")
  }
}
it.each(["staging", "production"] as const)(
  "deploys %s with its stable resource names and verifies the deployed bindings",
  async (environment) => {
    selectEnvironment(environment)
    failDeploy = false
    await expect(deploy()).resolves.toBeUndefined()
    expect(deployed).toBe(true)
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2)
    expect(mocks.spawnSync.mock.calls[0]?.[1]).toContain("migrations")
    expect(mocks.spawnSync.mock.calls[1]?.[1]).toContain("deploy")
  },
)
it.each([
  ["staging", "bucket", "eruoo-server-backups"],
  ["production", "bucket", "eruoo-server-backups-staging"],
  ["staging", "workflow", "eruoo-database-backup"],
  ["production", "workflow", "eruoo-database-backup-staging"],
  ["staging", "bucket", "eruoo-server-backups-v2-staging"],
  ["production", "workflow", "eruoo-server-backup-v2-production"],
] as const)(
  "rejects %s %s target %s before any remote request or mutation",
  async (environment, resource, name) => {
    selectEnvironment(environment)
    if (resource === "bucket") config.r2_buckets[0]!.bucket_name = name
    else config.workflows[0]!.name = name
    await expect(deploy()).rejects.toThrow(
      resource === "bucket"
        ? "Configure the isolated D1 and backup bucket"
        : "Release workflow identity differs",
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  },
)
it("resumes the real deployment script after migrations committed but deploy failed", async () => {
  await expect(deploy()).rejects.toThrow("Remote write failed")
  expect(
    db.prepare("SELECT count(*) AS n FROM deployment_migrations").get()?.n,
  ).toBe(1)
  mocks.spawnSync.mockClear()
  failDeploy = false
  await expect(deploy()).resolves.toBeUndefined()
  expect(mocks.spawnSync).toHaveBeenCalledTimes(1)
  expect(mocks.spawnSync.mock.calls[0]?.[1]).toContain("deploy")
  expect(deployed).toBe(true)
})
it("never writes to an unreceipted populated first deployment database", async () => {
  db.exec("CREATE TABLE user(id TEXT)")
  await expect(deploy()).rejects.toThrow("not empty")
  expect(mocks.spawnSync).not.toHaveBeenCalled()
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='deployment_migrations'",
      )
      .all(),
  ).toHaveLength(0)
})
it("does not reuse a previous deployment's authority for another populated database", async () => {
  priorDatabaseId = "22222222-2222-4222-8222-222222222222"
  db.exec("CREATE TABLE user(id TEXT)")
  await expect(deploy()).rejects.toThrow("not empty")
  expect(mocks.spawnSync).not.toHaveBeenCalled()
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='deployment_migrations'",
      )
      .all(),
  ).toHaveLength(0)
})
it("accepts the existing deployment only when its database binding matches", async () => {
  priorDatabaseId = databaseId
  db.exec(
    "CREATE TABLE user(id TEXT); CREATE TABLE d1_migrations(id INTEGER, name TEXT); INSERT INTO d1_migrations VALUES (1,'0001_foundation.sql');",
  )
  failDeploy = false
  await expect(deploy()).resolves.toBeUndefined()
  expect(mocks.spawnSync).toHaveBeenCalledTimes(1)
  expect(mocks.spawnSync.mock.calls[0]?.[1]).toContain("deploy")
})

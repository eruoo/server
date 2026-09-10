import { spawnSync, spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { parse, type ParseError } from "jsonc-parser"
const root = process.cwd()
const directory = path.join(root, ".generated/e2e")
await mkdir(directory, { recursive: true })
const parseErrors: ParseError[] = []
const config = parse(await readFile("wrangler.jsonc", "utf8"), parseErrors, {
  allowTrailingComma: true,
})
if (parseErrors.length) throw new Error("Invalid wrangler.jsonc")
delete config.env
delete config.secrets
config.name = "eruoo-e2e"
config.main = path.join(root, "src/worker/index.ts")
config.assets.directory = path.join(root, "dist/client")
config.vars = {
  ...config.vars,
  APP_ORIGIN: "http://localhost:5183",
  BETTER_AUTH_SECRETS: "1:e2e-authentication-secret-at-least-32-characters",
  GITHUB_CLIENT_ID: "e2e-client",
  GITHUB_CLIENT_SECRET: "e2e-client-secret",
  AUDIT_IP_HASH_SECRET: "e2e-audit-secret-with-at-least-32-characters",
  D1_EXPORT_API_TOKEN: "e2e-export-token",
}
config.d1_databases = [
  {
    binding: "DB",
    database_name: "eruoo-e2e",
    database_id: "33333333-3333-4333-8333-333333333333",
    migrations_dir: path.join(root, "migrations"),
  },
]
config.workflows[0].name = "eruoo-e2e-backup"
config.r2_buckets[0].bucket_name = "eruoo-e2e-backups"
const configPath = path.join(directory, "wrangler.jsonc")
await writeFile(configPath, JSON.stringify(config))
const cli = (args: string[]) => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      ...args,
      "--persist-to",
      path.join(root, ".wrangler/state"),
      "--config",
      configPath,
    ],
    { stdio: "inherit" },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}
cli(["d1", "migrations", "apply", "DB", "--local"])
const now = new Date().toISOString()
const expires = new Date(Date.now() + 30 * 86400000).toISOString()
const fixture = `DELETE FROM user;
DELETE FROM security_audit_events;
DELETE FROM apikey;
INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES ('e2e-owner','测试账号','owner@example.invalid',1,'${now}','${now}');
INSERT INTO account (id,issuer,accountId,providerId,userId,createdAt,updatedAt) VALUES ('e2e-github','https://github.com','50254496','github','e2e-owner','${now}','${now}');
INSERT INTO session (id,userId,token,createdAt,updatedAt,expiresAt,reauthenticatedAt) VALUES ('e2e-session','e2e-owner','e2e-session-token','${now}','${now}','${expires}','${now}');
DELETE FROM rateLimit;`
const fixturePath = path.join(directory, "fixture.sql")
await writeFile(fixturePath, fixture)
cli(["d1", "execute", "DB", "--local", "--file", fixturePath])
const child = spawn(
  "pnpm",
  ["exec", "vite", "--host", "127.0.0.1", "--port", "5183", "--strictPort"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ERUOO_WORKER_CONFIG: configPath,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
  },
)
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal))
child.on("exit", (code) => process.exit(code ?? 1))

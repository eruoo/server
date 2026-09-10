import { spawnSync, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { parseEnv } from "node:util"
let values: Record<string, string | undefined>
try {
  values = {
    ...parseEnv(await readFile(".dev.vars", "utf8")),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  }
} catch {
  throw new Error(
    "Create .dev.vars from .dev.vars.example and fill the local GitHub credentials before running dev",
  )
}
const required = [
  "BETTER_AUTH_SECRETS",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AUDIT_IP_HASH_SECRET",
]
const missing = required.filter(
  (name) => !values[name]?.trim() || /replace[-_]/i.test(values[name]!),
)
if (missing.length)
  throw new Error(
    `Local configuration required: ${missing.join(", ")}. See .dev.vars.example; values are never logged.`,
  )
if (Buffer.byteLength(values.AUDIT_IP_HASH_SECRET!) < 32)
  throw new Error("Local AUDIT_IP_HASH_SECRET must contain at least 32 bytes")
const migrated = spawnSync(
  "pnpm",
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"],
  { stdio: "inherit" },
)
if (migrated.status !== 0) process.exit(migrated.status ?? 1)
const server = spawn("pnpm", ["exec", "vite"], { stdio: "inherit" })
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.kill(signal))
server.on("exit", (code) => process.exit(code ?? 1))

import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))
const syntheticSecrets = {
  APP_ORIGIN: "http://localhost:5173",
  AUDIT_IP_HASH_SECRET: "synthetic-audit-secret-used-only-in-worker-tests",
  BETTER_AUTH_SECRETS:
    "1:synthetic-better-auth-secret-used-only-in-worker-tests",
  D1_EXPORT_API_TOKEN: "synthetic-export-token",
  GITHUB_CLIENT_ID: "synthetic-github-client-id",
  GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
} as const

Object.assign(process.env, syntheticSecrets)

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: path.resolve(rootDirectory, "wrangler.jsonc"),
      },
      miniflare: {
        bindings: {
          ...syntheticSecrets,
          TEST_MIGRATIONS: await readD1Migrations(
            path.resolve(rootDirectory, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["tests/worker/**/*.test.ts"],
    setupFiles: ["./tests/worker/apply-migrations.ts"],
    passWithNoTests: false,
  },
})

import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))

/**
 * 测试用合成凭证(仅存在于 workerd 内存,无真实值)。
 * BETTER_AUTH_SECRETS 保持 Better Auth 的 <version>:<secret> 形态
 * (value ≥32 字符,与生产校验一致)。
 */
const syntheticTestBindings = {
  APP_ORIGIN: "http://local.test",
  BETTER_AUTH_SECRETS:
    "1:synthetic-better-auth-secret-used-only-in-worker-tests-32ch",
  GITHUB_CLIENT_ID: "synthetic-github-client-id",
  GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
  OWNER_GITHUB_ID: "50254496",
} as const

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: path.resolve(rootDirectory, "wrangler.jsonc"),
        environment: "staging",
      },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ...syntheticTestBindings,
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

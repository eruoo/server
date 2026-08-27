import type { D1Migration } from "@cloudflare/vitest-pool-workers"
import { applyD1Migrations, env } from "cloudflare:test"
import { beforeAll } from "vitest"

interface TestEnv extends Env {
  TEST_MIGRATIONS: D1Migration[]
}

const testEnv = env as TestEnv

beforeAll(async () => {
  if (testEnv.TEST_MIGRATIONS.length === 0) {
    return
  }

  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS)
})

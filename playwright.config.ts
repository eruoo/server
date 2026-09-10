import { defineConfig, devices } from "@playwright/test"
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:5183",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx scripts/e2e-server.ts",
    url: "http://127.0.0.1:5183/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
})

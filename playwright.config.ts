import { defineConfig, devices } from "@playwright/test"

import {
  e2eOrigin,
  e2ePort,
  e2eReadinessOrigin,
  e2eServerHost,
} from "./tests/client/e2e/support"

export default defineConfig({
  testDir: "./tests/client/e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "output/playwright/results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "output/playwright/report",
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: e2eOrigin,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev --mode e2e --host ${e2eServerHost} --port ${e2ePort}`,
    env: {
      APP_ORIGIN: e2eOrigin,
      AUDIT_IP_HASH_SECRET: "synthetic-audit-secret-used-only-in-browser-tests",
      BETTER_AUTH_SECRETS:
        "1:synthetic-better-auth-secret-used-only-in-browser-tests",
      D1_EXPORT_API_TOKEN: "synthetic-export-token-used-only-in-browser-tests",
      GITHUB_CLIENT_ID: "synthetic-github-client-id",
      GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
    },
    url: e2eReadinessOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})

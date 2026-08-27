import { defineConfig, devices } from "@playwright/test"

const browserOrigin = "http://localhost:5173"
const developmentServerUrl = "http://127.0.0.1:5173"

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
    baseURL: browserOrigin,
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
    command: "pnpm dev --mode e2e --host 127.0.0.1",
    env: {
      APP_ORIGIN: browserOrigin,
      AUDIT_IP_HASH_SECRET: "synthetic-audit-secret-used-only-in-browser-tests",
      BETTER_AUTH_SECRETS:
        "1:synthetic-better-auth-secret-used-only-in-browser-tests",
      D1_EXPORT_API_TOKEN: "synthetic-export-token-used-only-in-browser-tests",
      GITHUB_CLIENT_ID: "synthetic-github-client-id",
      GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
    },
    url: developmentServerUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})

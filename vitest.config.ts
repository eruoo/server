import path from "node:path"
import { fileURLToPath } from "node:url"

import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      wrangler: {
        configPath: path.resolve(rootDirectory, "wrangler.jsonc"),
        environment: "staging",
      },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["tests/worker/**/*.test.ts"],
    passWithNoTests: false,
  },
})

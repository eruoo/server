import path from "node:path"
import { fileURLToPath } from "node:url"

import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@client": path.resolve(rootDirectory, "src/client"),
      "@shared": path.resolve(rootDirectory, "src/shared"),
    },
  },
  test: {
    name: "client",
    environment: "happy-dom",
    include: ["tests/client/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
})

import { cloudflare } from "@cloudflare/vite-plugin"
import tailwind from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import * as compiler from "vue/compiler-sfc"

export default defineConfig({
  plugins: [
    {
      ...vue({ compiler }),
      applyToEnvironment: (environment) => environment.name === "client",
    },
    tailwind(),
    cloudflare({
      configPath: process.env.ERUOO_WORKER_CONFIG ?? "wrangler.jsonc",
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/.wrangler/**",
        "**/.generated/**",
        "**/test-results/**",
        "**/.output/**",
      ],
    },
  },
})

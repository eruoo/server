import { copyFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { cloudflare } from "@cloudflare/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig, type Plugin } from "vite"

import { SCALAR_STANDALONE_ASSET_PATH } from "./src/shared/scalar.ts"
import { e2eBootstrapToken } from "./tests/client/e2e/support.ts"

const rootDirectory = path.dirname(fileURLToPath(import.meta.url))
const generatedArtifactDirectories = [
  path.resolve(rootDirectory, ".wrangler"),
  path.resolve(rootDirectory, "output/playwright"),
]
const scalarPackageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("@scalar/api-reference"))),
  "..",
)
const scalarStandaloneSourcePath = path.join(
  scalarPackageDirectory,
  "dist/browser/standalone.js",
)
const scalarStandaloneOutputPath = SCALAR_STANDALONE_ASSET_PATH.slice(1)

function scalarStandaloneAsset(): Plugin {
  return {
    name: "eruoo-scalar-standalone-asset",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost:5173")

        if (
          requestUrl.pathname !== SCALAR_STANDALONE_ASSET_PATH ||
          (request.method !== "GET" && request.method !== "HEAD")
        ) {
          next()
          return
        }

        try {
          const source = await readFile(scalarStandaloneSourcePath)
          response.statusCode = 200
          response.setHeader(
            "Content-Type",
            "application/javascript; charset=utf-8",
          )
          response.setHeader("Cache-Control", "public, max-age=3600")
          response.end(request.method === "HEAD" ? undefined : source)
        } catch (error) {
          next(error as Error)
        }
      })
    },
    async writeBundle(options) {
      if (
        !options.dir ||
        path.resolve(options.dir) !== path.resolve(rootDirectory, "dist/client")
      ) {
        return
      }

      const outputPath = path.resolve(options.dir, scalarStandaloneOutputPath)
      await mkdir(path.dirname(outputPath), { recursive: true })
      await copyFile(scalarStandaloneSourcePath, outputPath)
    },
  }
}

function isGeneratedArtifact(filePath: string) {
  const absolutePath = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(rootDirectory, filePath)

  return generatedArtifactDirectories.some(
    (directory) =>
      absolutePath === directory ||
      absolutePath.startsWith(`${directory}${path.sep}`),
  )
}

export default defineConfig(({ command, mode }) => {
  const usesE2EWorker = mode === "e2e"

  if (usesE2EWorker && command !== "serve") {
    throw new Error("The test-only E2E Worker cannot be built for deployment.")
  }

  return {
    ...(usesE2EWorker
      ? { cacheDir: path.resolve(rootDirectory, "node_modules/.vite-e2e") }
      : {}),
    plugins: [
      vue(),
      tailwindcss(),
      scalarStandaloneAsset(),
      cloudflare(
        usesE2EWorker
          ? {
              config: (config) => ({
                main: "./tests/worker/e2e-entry.ts",
                name: "eruoo-server-e2e",
                preview_urls: false,
                routes: [],
                vars: {
                  ...config.vars,
                  E2E_BOOTSTRAP_TOKEN: e2eBootstrapToken,
                },
                workers_dev: false,
              }),
              persistState: {
                path: path.resolve(
                  rootDirectory,
                  `.wrangler/e2e-state-${process.pid}`,
                ),
              },
            }
          : undefined,
      ),
    ],
    server: {
      port: 5173,
      strictPort: true,
      watch: {
        ignored: isGeneratedArtifact,
      },
    },
    resolve: {
      alias: {
        "@client": path.resolve(rootDirectory, "src/client"),
        "@shared": path.resolve(rootDirectory, "src/shared"),
        "@worker": path.resolve(rootDirectory, "src/worker"),
      },
    },
    build: {
      license: {
        fileName: "THIRD_PARTY_LICENSES.md",
      },
      sourcemap: false,
    },
  }
})

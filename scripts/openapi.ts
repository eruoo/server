import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { OWNER_GITHUB_ID } from "../src/shared/security"
import { createApp } from "../src/worker/app"
import { createOpenApiDocument } from "../src/worker/openapi"
import {
  assertOpenApiContract,
  assertProtectedOperationsRejectAnonymous,
} from "./openapi-contract"
import type {
  OpenApiOperationKey,
  OpenApiRuntimeRequestFixtures,
} from "./openapi-contract"

const artifactPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/openapi.json",
)
const publicOperationAllowlist =
  [] as const satisfies readonly OpenApiOperationKey[]
const protectedOperationRequestFixtures = {
  "DELETE /api/oauth/authorizations/{clientId}": {
    path: "/api/oauth/authorizations/eruoo-desktop",
  },
} satisfies OpenApiRuntimeRequestFixtures
const contractCheckDatabase = {
  prepare: () => ({
    bind: () => ({ run: async () => ({ success: true }) }),
  }),
} as unknown as D1Database
const contractCheckEnvironment = {
  ALLOWED_CORS_ORIGINS: "[]",
  APP_ENV: "development",
  APP_ORIGIN: "http://localhost:5173",
  AUTH_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
  AUDIT_IP_HASH_SECRET:
    "synthetic-openapi-audit-secret-at-least-thirty-two-bytes",
  BETTER_AUTH_SECRETS:
    "1:synthetic-better-auth-secret-used-only-for-openapi-checks",
  DB: contractCheckDatabase,
  GITHUB_CLIENT_ID: "synthetic-openapi-check-client-id",
  GITHUB_CLIENT_SECRET: "synthetic-openapi-check-client-secret",
  OWNER_GITHUB_ID,
} as unknown as Env
const document = createOpenApiDocument(createApp())

assertOpenApiContract({ document, publicOperationAllowlist })
await assertProtectedOperationsRejectAnonymous({
  document,
  invoke: async ({ body, headers, method, path: requestPath }) => {
    const app = createApp()
    const backgroundTasks: Promise<unknown>[] = []
    const executionContext = {
      passThroughOnException() {},
      props: {},
      waitUntil(promise: Promise<unknown>) {
        backgroundTasks.push(promise)
      },
    } as unknown as ExecutionContext
    const response = await app.fetch(
      new Request(new URL(requestPath, "https://openapi.invalid"), {
        ...(body === undefined ? {} : { body }),
        ...(headers === undefined ? {} : { headers }),
        method,
      }),
      contractCheckEnvironment,
      executionContext,
    )
    await Promise.all(backgroundTasks)
    return response
  },
  publicOperationAllowlist,
  requestFixtures: protectedOperationRequestFixtures,
})

const output = `${JSON.stringify(document, null, 2)}\n`

if (process.argv.includes("--write")) {
  await writeFile(artifactPath, output, "utf8")
} else if (process.argv.includes("--check")) {
  let current: string

  try {
    current = await readFile(artifactPath, "utf8")
  } catch {
    throw new Error(
      "OpenAPI artifact is missing. Run pnpm run openapi:generate.",
    )
  }

  if (current !== output) {
    throw new Error("OpenAPI artifact is stale. Run pnpm run openapi:generate.")
  }
} else {
  throw new Error("Expected --write or --check")
}

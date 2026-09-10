import { readFile, writeFile } from "node:fs/promises"

import { OpenAPIHono } from "@hono/zod-openapi"

import type { AppBindings } from "../src/worker/http/types"
import { registerApplicationRoutes } from "../src/worker/routes"
import { getOpenAPIDocument } from "../src/worker/routes/api-documentation"
const app = new OpenAPIHono<AppBindings>()
registerApplicationRoutes(app)
const expected = JSON.stringify(getOpenAPIDocument(app), null, 2) + "\n"
if (process.argv.includes("--check")) {
  if ((await readFile("docs/openapi.json", "utf8")) !== expected)
    throw new Error("Generated OpenAPI is stale; run pnpm openapi:generate")
} else await writeFile("docs/openapi.json", expected)

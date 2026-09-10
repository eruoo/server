import type { OpenAPIHono } from "@hono/zod-openapi"

import { readOwnerSession } from "../auth/session"
import { problem, withReadDeadline } from "../http/response"
import type { AppBindings } from "../http/types"
export function getOpenAPIDocument(app: OpenAPIHono<AppBindings>) {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "eruoo API", version: "2.0.0" },
    servers: [{ url: "/" }],
  })
}
export function registerApiDocumentation(app: OpenAPIHono<AppBindings>) {
  app.openAPIRegistry.registerComponent("securitySchemes", "ownerSession", {
    type: "apiKey",
    in: "cookie",
    name: "__Secure-eruoo.session_token",
  })
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
  })
  for (const path of ["/api/docs", "/api/openapi.json"])
    app.get(path, async (c) => {
      if (c.req.method !== "GET" || new URL(c.req.url).pathname !== path)
        return problem("not-found", c.get("requestId"))
      return withReadDeadline(
        (async () => {
          const owner = await readOwnerSession(c)
          if (owner instanceof Response) return owner
          if (path === "/api/openapi.json")
            return c.json(getOpenAPIDocument(app), 200, {
              "cache-control": "private, no-store",
            })
          const response = await c.env.ASSETS.fetch(
            new Request(new URL("/", c.req.url)),
          )
          return new Response(response.body, {
            status: response.status,
            headers: {
              ...Object.fromEntries(response.headers),
              "cache-control": "private, no-store",
            },
          })
        })(),
        c.get("requestId"),
      )
    })
}

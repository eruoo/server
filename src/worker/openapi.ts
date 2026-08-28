import type { OpenAPIHono } from "@hono/zod-openapi"

import type { AppBindings } from "./http/types"

export type OpenApiDocument = ReturnType<
  OpenAPIHono<AppBindings>["getOpenAPI31Document"]
>

interface OpenApiDocumentSource {
  getOpenAPI31Document: OpenAPIHono<AppBindings>["getOpenAPI31Document"]
}

export function createOpenApiDocument(
  source: OpenApiDocumentSource,
): OpenApiDocument {
  return source.getOpenAPI31Document({
    info: {
      description:
        "Owner-only identity management and future authenticated business API.",
      title: "eruoo API",
      version: "0.0.1",
    },
    openapi: "3.1.0",
    servers: [
      {
        description: "Production",
        url: "https://auth.eruoo.me",
      },
    ],
    tags: [
      {
        description:
          "Owner-only security audit and OAuth authorization management.",
        name: "Security",
      },
      {
        description: "Service and dependency status available to the owner.",
        name: "System",
      },
    ],
  })
}

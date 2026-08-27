import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { API_KEY_EXPIRATION_HEADER } from "../../shared/api-key"
import { requireOwnerSessionOrStatusApiKey } from "../auth/api-key"
import { problemSchema } from "../http/problem"
import type { AppBindings } from "../http/types"

const statusSchema = z
  .object({
    status: z.literal("ok"),
  })
  .openapi("Status")

const statusRoute = createRoute({
  method: "get",
  operationId: "getStatus",
  path: "/api/status",
  security: [{ ownerSession: [] }, { apiKey: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: statusSchema,
        },
      },
      headers: {
        [API_KEY_EXPIRATION_HEADER]: {
          description:
            "UTC RFC 3339 expiration returned only for a successfully authenticated API key with at most 14 days remaining.",
          schema: {
            format: "date-time",
            type: "string",
          },
        },
      },
      description:
        "The owner Session or status:read API key and its D1 record are valid.",
    },
    400: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The request contains ambiguous credential carriers.",
    },
    401: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "A valid owner Session or status:read API key is required.",
    },
    403: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The authenticated API key does not grant status:read.",
    },
    429: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The API key request limit was exceeded.",
    },
    503: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The credential dependency could not be checked.",
    },
    500: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The request failed unexpectedly.",
    },
    504: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The request exceeded the service time limit.",
    },
  },
  tags: ["System"],
})

export const statusRouter = new OpenAPIHono<AppBindings>({ strict: true })

statusRouter.use("/api/status", requireOwnerSessionOrStatusApiKey)
statusRouter.openapi(statusRoute, (context) =>
  context.json(statusSchema.parse({ status: "ok" }), 200, {
    "Cache-Control": "no-store",
  }),
)

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { auditEventTypes } from "../audit"
import { requireOwnerSession } from "../auth/session"
import { problem, problemSchema } from "../http/problem"
import {
  problemTypeRegistry,
  problemTypeUri,
  type ProblemSlug,
} from "../http/problem-registry"
import type { AppBindings } from "../http/types"
import {
  type AuditEventListOptions,
  InvalidAuditCursorError,
  InvalidStoredAuditEventError,
  listAuditEvents,
} from "../modules/audit/repository"

const canonicalUnsignedIntegerPattern = /^(?:0|[1-9][0-9]*)$/
const opaqueCursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function integerQueryParameter(options: {
  description: string
  format: "int32" | "int64"
  maximum?: number
  minimum: number
}) {
  return z
    .string()
    .regex(canonicalUnsignedIntegerPattern)
    .transform(Number)
    .pipe(
      z
        .int()
        .min(options.minimum)
        .max(options.maximum ?? Number.MAX_SAFE_INTEGER),
    )
    .openapi({
      description: options.description,
      format: options.format,
      maximum: options.maximum ?? Number.MAX_SAFE_INTEGER,
      minimum: options.minimum,
      type: "integer",
    })
}

const auditEventQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .regex(opaqueCursorPattern)
      .openapi({
        description:
          "Exclusive opaque cursor returned by the preceding page. It is bound to the active filters.",
      })
      .optional(),
    from: integerQueryParameter({
      description:
        "Inclusive lower occurredAt bound as Unix epoch milliseconds.",
      format: "int64",
      minimum: 0,
    }).optional(),
    limit: integerQueryParameter({
      description:
        "Number of events to return. Defaults to 50 and cannot exceed 100.",
      format: "int32",
      maximum: 100,
      minimum: 1,
    }).optional(),
    outcome: z.enum(["failure", "success"]).optional(),
    to: integerQueryParameter({
      description:
        "Inclusive upper occurredAt bound as Unix epoch milliseconds.",
      format: "int64",
      minimum: 0,
    }).optional(),
    type: z.enum(auditEventTypes).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from > query.to
    ) {
      context.addIssue({
        code: "custom",
        message: "from must be less than or equal to to",
        path: ["from"],
      })
    }
  })

const auditMetadataValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string(),
])

const auditEventSchema = z
  .object({
    clientId: z.string().min(1).nullable(),
    credentialId: z.string().min(1).nullable(),
    id: z.string().min(1),
    ipFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .openapi({
        description:
          "Keyed HMAC fingerprint of the Cloudflare-provided client IP; never the original IP address.",
      }),
    metadata: z.record(z.string(), auditMetadataValueSchema).nullable(),
    occurredAt: z.int().nonnegative().openapi({
      description: "Event time as Unix epoch milliseconds.",
      format: "int64",
    }),
    outcome: z.enum(["failure", "success"]),
    requestId: z.string().min(1),
    subjectId: z.string().min(1).nullable(),
    type: z.enum(auditEventTypes),
  })
  .strict()
  .openapi("SecurityAuditEvent")

const auditEventPageSchema = z
  .object({
    events: z.array(auditEventSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .openapi("SecurityAuditEventPage")

const listAuditEventsRoute = createRoute({
  method: "get",
  operationId: "listSecurityAuditEvents",
  path: "/api/security/audit-events",
  request: {
    query: auditEventQuerySchema,
  },
  security: [{ ownerSession: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: auditEventPageSchema,
        },
      },
      description:
        "Security events from the preceding 180 days in descending keyset order.",
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
      description: "A valid owner Session is required.",
    },
    422: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description:
        "The filters, page size, or cursor do not satisfy the query contract.",
    },
    500: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "Stored audit data does not satisfy its invariant.",
    },
    503: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The audit database could not be queried.",
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
  tags: ["Security"],
})

function createProblemBody(
  context: Parameters<typeof problem>[0],
  slug: ProblemSlug,
  detail: string,
  errors?: NonNullable<z.infer<typeof problemSchema>["errors"]>,
) {
  const definition = problemTypeRegistry[slug]

  return problemSchema.parse({
    detail,
    ...(errors === undefined ? {} : { errors }),
    requestId: context.get("requestId"),
    status: definition.status,
    title: definition.title,
    type: problemTypeUri(slug),
  })
}

export const auditEventsRouter = new OpenAPIHono<AppBindings>({
  defaultHook: (result, context) => {
    if (result.success) return

    return problem(context, {
      detail: "The audit query does not satisfy the operation contract.",
      errors: result.error.issues.map((issue) => ({
        detail: issue.message,
        location: "query" as const,
        pointer: `/${issue.path.map(String).join("/")}`,
      })),
      slug: "validation-failed",
    })
  },
  strict: true,
})

auditEventsRouter.use("/api/security/audit-events", requireOwnerSession)

auditEventsRouter.openapi(listAuditEventsRoute, async (context) => {
  const query = context.req.valid("query")
  const options: AuditEventListOptions = {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.type === undefined ? {} : { type: query.type }),
  }

  try {
    const page = await listAuditEvents(
      context.env.DB,
      context.env.AUDIT_IP_HASH_SECRET,
      options,
    )

    return context.json(auditEventPageSchema.parse(page), 200, {
      "Cache-Control": "private, no-store",
    })
  } catch (error) {
    if (
      error instanceof InvalidAuditCursorError ||
      error instanceof RangeError
    ) {
      return context.json(
        createProblemBody(
          context,
          "validation-failed",
          "The audit cursor is invalid or does not match the active filters.",
          [
            {
              detail: "Use a cursor returned for the current filter set.",
              location: "query",
              pointer: "/cursor",
            },
          ],
        ),
        422,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }

    if (
      error instanceof InvalidStoredAuditEventError ||
      error instanceof z.ZodError
    ) {
      console.error({
        event: "audit_query_data_invalid",
        error: error.name,
        requestId: context.get("requestId"),
      })

      return context.json(
        createProblemBody(
          context,
          "internal-error",
          "The audit events could not be returned.",
        ),
        500,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }

    console.error({
      event: "audit_query_failed",
      error: error instanceof Error ? error.name : "unknown_error",
      requestId: context.get("requestId"),
    })

    return context.json(
      createProblemBody(
        context,
        "service-unavailable",
        "The audit database is temporarily unavailable.",
      ),
      503,
      {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    )
  }
})

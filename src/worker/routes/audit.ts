import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { auditEventTypes } from "../audit"
import { readOwnerSession } from "../auth/session"
import { problem, withReadDeadline, errorResponse } from "../http/response"
import type { AppBindings } from "../http/types"
import {
  listAuditEvents,
  InvalidAuditCursorError,
} from "../modules/audit/repository"

const integerParameter = (max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.int().nonnegative().max(max))
const querySchema = z
  .object({
    type: z.enum(auditEventTypes).optional(),
    outcome: z.enum(["success", "failure"]).optional(),
    from: integerParameter().optional(),
    to: integerParameter().optional(),
    limit: integerParameter(100).pipe(z.int().min(1)).optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      value.from <= value.to,
  )
const eventSchema = z
  .object({
    id: z.string(),
    type: z.enum(auditEventTypes),
    outcome: z.enum(["success", "failure"]),
    occurredAt: z.int(),
    subjectId: z.string().nullable(),
    credentialId: z.string().nullable(),
    clientId: z.string().nullable(),
    ipFingerprint: z.string().nullable(),
    requestId: z.string(),
    metadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .nullable(),
  })
  .openapi("SecurityAuditEvent")
export const auditRoute = createRoute({
  method: "get",
  path: "/api/security/audit-events",
  operationId: "listSecurityAuditEvents",
  security: [{ ownerSession: [] }],
  responses: {
    default: errorResponse,
    200: {
      description: "Security events in descending keyset order",
      content: {
        "application/json": {
          schema: z
            .object({
              events: z.array(eventSchema),
              nextCursor: z.string().nullable(),
            })
            .openapi("SecurityAuditEventPage"),
        },
      },
    },
  },
})
export function registerAuditRoute(app: OpenAPIHono<AppBindings>) {
  app.openAPIRegistry.registerPath({
    ...auditRoute,
    request: { query: querySchema },
  })
  app.get(auditRoute.path, async (c) => {
    if (
      c.req.method !== "GET" ||
      new URL(c.req.url).pathname !== auditRoute.path
    )
      return problem("not-found", c.get("requestId"))
    return withReadDeadline(
      (async () => {
        const owner = await readOwnerSession(c)
        if (owner instanceof Response) return owner
        const url = new URL(c.req.url)
        if (
          [...url.searchParams.keys()].some(
            (key) => url.searchParams.getAll(key).length > 1,
          )
        )
          return problem("invalid-request", c.get("requestId"))
        const query = querySchema.safeParse(
          Object.fromEntries(url.searchParams),
        )
        if (!query.success)
          return problem("validation-failed", c.get("requestId"))
        try {
          const result = await listAuditEvents(
            c.env.DB,
            c.env.AUDIT_IP_HASH_SECRET,
            query.data,
          )
          return c.json(result, 200, { "cache-control": "private, no-store" })
        } catch (error) {
          return problem(
            error instanceof InvalidAuditCursorError
              ? "validation-failed"
              : "service-unavailable",
            c.get("requestId"),
          )
        }
      })(),
      c.get("requestId"),
    )
  })
}

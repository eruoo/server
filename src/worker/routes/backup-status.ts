import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { readOwnerSession } from "../auth/session"
import { DATABASE_BACKUP_ERROR_CODES } from "../backup/errors"
import {
  getDatabaseBackupStatus,
  InvalidStoredDatabaseBackupHealthError,
} from "../backup/health"
import { errorResponse, problem, withReadDeadline } from "../http/response"
import type { AppBindings } from "../http/types"
const maximumDateTimestamp = 8_640_000_000_000_000

const epochMillisecondSchema = z
  .int()
  .nonnegative()
  .max(maximumDateTimestamp)
  .openapi({
    description: "Unix epoch milliseconds.",
    format: "int64",
  })

const databaseBackupStatusSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        errorCode: z.null(),
        lastAttemptAt: z.null(),
        lastSuccessAt: z.null(),
        status: z.literal("never-run"),
      })
      .strict(),
    z
      .object({
        errorCode: z.null(),
        lastAttemptAt: epochMillisecondSchema,
        lastSuccessAt: epochMillisecondSchema,
        status: z.literal("ok"),
      })
      .strict(),
    z
      .object({
        errorCode: z.enum(DATABASE_BACKUP_ERROR_CODES),
        lastAttemptAt: epochMillisecondSchema,
        lastSuccessAt: epochMillisecondSchema.nullable(),
        status: z.literal("failed"),
      })
      .strict(),
  ])
  .openapi("DatabaseBackupStatus")

export function registerBackupStatusRoute(app: OpenAPIHono<AppBindings>) {
  const route = createRoute({
    method: "get",
    path: "/api/security/backup-status",
    operationId: "getDatabaseBackupStatus",
    security: [{ ownerSession: [] }],
    responses: {
      default: errorResponse,
      200: {
        description: "Latest durable backup health",
        content: { "application/json": { schema: databaseBackupStatusSchema } },
      },
    },
  })
  app.openapi(route, async (c) => {
    if (c.req.method !== "GET" || new URL(c.req.url).pathname !== route.path)
      return problem("not-found", c.get("requestId"))
    return withReadDeadline(
      (async () => {
        const owner = await readOwnerSession(c)
        if (owner instanceof Response) return owner
        try {
          return c.json(
            databaseBackupStatusSchema.parse(
              await getDatabaseBackupStatus(c.env.DB),
            ),
            200,
            { "cache-control": "private, no-store" },
          )
        } catch (error) {
          return problem(
            error instanceof InvalidStoredDatabaseBackupHealthError ||
              error instanceof z.ZodError
              ? "internal-error"
              : "service-unavailable",
            c.get("requestId"),
          )
        }
      })(),
      c.get("requestId"),
    )
  })
}

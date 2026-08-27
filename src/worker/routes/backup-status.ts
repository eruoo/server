import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { requireOwnerSession } from "../auth/session"
import { DATABASE_BACKUP_ERROR_CODES } from "../backup/errors"
import {
  getDatabaseBackupStatus,
  InvalidStoredDatabaseBackupHealthError,
} from "../backup/health"
import { problem, problemSchema } from "../http/problem"
import {
  problemTypeRegistry,
  problemTypeUri,
  type ProblemSlug,
} from "../http/problem-registry"
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

const getDatabaseBackupStatusRoute = createRoute({
  method: "get",
  operationId: "getDatabaseBackupStatus",
  path: "/api/security/backup-status",
  security: [{ ownerSession: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: databaseBackupStatusSchema,
        },
      },
      description: "The latest durable database backup health state.",
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
    500: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "Stored backup health does not satisfy its invariant.",
    },
    503: {
      content: {
        "application/problem+json": {
          schema: problemSchema,
        },
      },
      description: "The backup health database could not be queried.",
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
) {
  const definition = problemTypeRegistry[slug]

  return problemSchema.parse({
    detail,
    requestId: context.get("requestId"),
    status: definition.status,
    title: definition.title,
    type: problemTypeUri(slug),
  })
}

export const backupStatusRouter = new OpenAPIHono<AppBindings>({ strict: true })

backupStatusRouter.use("/api/security/backup-status", requireOwnerSession)

backupStatusRouter.openapi(getDatabaseBackupStatusRoute, async (context) => {
  try {
    const status = await getDatabaseBackupStatus(context.env.DB)

    return context.json(databaseBackupStatusSchema.parse(status), 200, {
      "Cache-Control": "private, no-store",
    })
  } catch (error) {
    if (
      error instanceof InvalidStoredDatabaseBackupHealthError ||
      error instanceof z.ZodError
    ) {
      console.error({
        event: "database_backup_status_data_invalid",
        error: error.name,
        requestId: context.get("requestId"),
      })

      return context.json(
        createProblemBody(
          context,
          "internal-error",
          "The database backup status could not be returned.",
        ),
        500,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }

    console.error({
      event: "database_backup_status_query_failed",
      error: error instanceof Error ? error.name : "unknown_error",
      requestId: context.get("requestId"),
    })

    return context.json(
      createProblemBody(
        context,
        "service-unavailable",
        "The database backup status is temporarily unavailable.",
      ),
      503,
      {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    )
  }
})

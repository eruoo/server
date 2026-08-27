import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"

import { databaseBackupHealth } from "../db/schema"
import {
  DATABASE_BACKUP_ERROR_CODES,
  type DatabaseBackupErrorCode,
  isDatabaseBackupErrorCode,
} from "./errors"

export const DATABASE_BACKUP_HEALTH_NAME = "database-backup"
const maximumDateTimestamp = 8_640_000_000_000_000

const epochMillisecondSchema = z
  .number()
  .int()
  .nonnegative()
  .max(maximumDateTimestamp)

const terminalStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      completedAt: epochMillisecondSchema,
      runId: z.string().min(1).max(128),
      startedAt: epochMillisecondSchema,
      status: z.literal("ok"),
    })
    .strict(),
  z
    .object({
      completedAt: epochMillisecondSchema,
      failureCode: z.enum(DATABASE_BACKUP_ERROR_CODES),
      runId: z.string().min(1).max(128),
      startedAt: epochMillisecondSchema,
      status: z.literal("failed"),
    })
    .strict(),
])

const storedHealthSchema = z
  .object({
    completedAt: epochMillisecondSchema,
    failureCode: z.string().nullable(),
    lastSuccessAt: epochMillisecondSchema.nullable(),
    name: z.literal(DATABASE_BACKUP_HEALTH_NAME),
    runId: z.string().min(1).max(128),
    startedAt: epochMillisecondSchema,
    status: z.enum(["failed", "ok"]),
  })
  .strict()
  .superRefine((row, context) => {
    if (row.completedAt < row.startedAt) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"],
      })
    }

    if (row.status === "ok") {
      if (row.failureCode !== null) {
        context.addIssue({
          code: "custom",
          message: "a successful backup must not retain a failure code",
          path: ["failureCode"],
        })
      }

      if (row.lastSuccessAt === null) {
        context.addIssue({
          code: "custom",
          message: "a successful backup must record a success time",
          path: ["lastSuccessAt"],
        })
      }
    } else if (
      row.failureCode === null ||
      !DATABASE_BACKUP_ERROR_CODES.some((code) => code === row.failureCode)
    ) {
      context.addIssue({
        code: "custom",
        message: "a failed backup must contain a known failure code",
        path: ["failureCode"],
      })
    }
  })

export type DatabaseBackupTerminalState = z.input<typeof terminalStateSchema>

export type DatabaseBackupStatus =
  | {
      errorCode: null
      lastAttemptAt: null
      lastSuccessAt: null
      status: "never-run"
    }
  | {
      errorCode: null
      lastAttemptAt: number
      lastSuccessAt: number
      status: "ok"
    }
  | {
      errorCode: DatabaseBackupErrorCode
      lastAttemptAt: number
      lastSuccessAt: number | null
      status: "failed"
    }

export class InvalidDatabaseBackupTerminalStateError extends Error {
  override readonly name = "InvalidDatabaseBackupTerminalStateError"
}

export class InvalidStoredDatabaseBackupHealthError extends Error {
  override readonly name = "InvalidStoredDatabaseBackupHealthError"
}

const incomingTerminalStateWins = sql`
  excluded."startedAt" > "database_backup_health"."startedAt"
  OR (
    excluded."startedAt" = "database_backup_health"."startedAt"
    AND excluded."completedAt" > "database_backup_health"."completedAt"
  )
  OR (
    excluded."startedAt" = "database_backup_health"."startedAt"
    AND excluded."completedAt" = "database_backup_health"."completedAt"
    AND excluded."status" = 'ok'
    AND "database_backup_health"."status" = 'failed'
  )
  OR (
    excluded."startedAt" = "database_backup_health"."startedAt"
    AND excluded."completedAt" = "database_backup_health"."completedAt"
    AND excluded."status" = "database_backup_health"."status"
    AND excluded."runId" > "database_backup_health"."runId"
  )
  OR (
    excluded."startedAt" = "database_backup_health"."startedAt"
    AND excluded."completedAt" = "database_backup_health"."completedAt"
    AND excluded."status" = "database_backup_health"."status"
    AND excluded."runId" = "database_backup_health"."runId"
    AND COALESCE(excluded."failureCode", '') >
      COALESCE("database_backup_health"."failureCode", '')
  )
`

export async function recordDatabaseBackupTerminalState(
  databaseBinding: D1Database,
  state: DatabaseBackupTerminalState,
): Promise<void> {
  const parsed = terminalStateSchema.safeParse(state)

  if (!parsed.success || parsed.data.completedAt < parsed.data.startedAt) {
    throw new InvalidDatabaseBackupTerminalStateError(
      "The database backup terminal state is invalid.",
    )
  }

  const failureCode =
    parsed.data.status === "failed" ? parsed.data.failureCode : null
  const lastSuccessAt =
    parsed.data.status === "ok" ? parsed.data.completedAt : null
  const database = drizzle(databaseBinding)

  await database.run(sql`
    INSERT INTO ${databaseBackupHealth} (
      "name",
      "status",
      "runId",
      "startedAt",
      "completedAt",
      "lastSuccessAt",
      "failureCode"
    ) VALUES (
      ${DATABASE_BACKUP_HEALTH_NAME},
      ${parsed.data.status},
      ${parsed.data.runId},
      ${parsed.data.startedAt},
      ${parsed.data.completedAt},
      ${lastSuccessAt},
      ${failureCode}
    )
    ON CONFLICT ("name") DO UPDATE SET
      "status" = CASE
        WHEN ${incomingTerminalStateWins} THEN excluded."status"
        ELSE "database_backup_health"."status"
      END,
      "runId" = CASE
        WHEN ${incomingTerminalStateWins} THEN excluded."runId"
        ELSE "database_backup_health"."runId"
      END,
      "startedAt" = CASE
        WHEN ${incomingTerminalStateWins} THEN excluded."startedAt"
        ELSE "database_backup_health"."startedAt"
      END,
      "completedAt" = CASE
        WHEN ${incomingTerminalStateWins} THEN excluded."completedAt"
        ELSE "database_backup_health"."completedAt"
      END,
      "lastSuccessAt" = CASE
        WHEN excluded."status" = 'ok'
          AND (
            "database_backup_health"."lastSuccessAt" IS NULL
            OR excluded."completedAt" >
              "database_backup_health"."lastSuccessAt"
          )
          THEN excluded."completedAt"
        ELSE "database_backup_health"."lastSuccessAt"
      END,
      "failureCode" = CASE
        WHEN ${incomingTerminalStateWins} THEN excluded."failureCode"
        ELSE "database_backup_health"."failureCode"
      END
  `)
}

export async function getDatabaseBackupStatus(
  databaseBinding: D1Database,
): Promise<DatabaseBackupStatus> {
  const database = drizzle(databaseBinding)
  const [row] = await database
    .select()
    .from(databaseBackupHealth)
    .where(eq(databaseBackupHealth.name, DATABASE_BACKUP_HEALTH_NAME))
    .limit(1)

  if (!row) {
    return {
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    }
  }

  const parsed = storedHealthSchema.safeParse(row)
  if (!parsed.success) {
    throw new InvalidStoredDatabaseBackupHealthError(
      "Stored database backup health does not satisfy its invariant.",
    )
  }

  if (parsed.data.status === "ok") {
    if (
      parsed.data.lastSuccessAt === null ||
      parsed.data.failureCode !== null
    ) {
      throw new InvalidStoredDatabaseBackupHealthError(
        "Stored successful backup health is incomplete.",
      )
    }

    return {
      errorCode: null,
      lastAttemptAt: parsed.data.completedAt,
      lastSuccessAt: parsed.data.lastSuccessAt,
      status: "ok",
    }
  }

  if (
    parsed.data.failureCode === null ||
    !isDatabaseBackupErrorCode(parsed.data.failureCode)
  ) {
    throw new InvalidStoredDatabaseBackupHealthError(
      "Stored failed backup health does not contain a known error code.",
    )
  }

  return {
    errorCode: parsed.data.failureCode,
    lastAttemptAt: parsed.data.completedAt,
    lastSuccessAt: parsed.data.lastSuccessAt,
    status: "failed",
  }
}

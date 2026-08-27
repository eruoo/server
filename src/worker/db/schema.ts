import { desc, sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

import type { DatabaseBackupErrorCode } from "../backup/errors"

export const oauthRefreshTokenFamilyRevocations = sqliteTable(
  "oauthRefreshTokenFamilyRevocation",
  {
    authorizationCodeId: text().notNull(),
    clientId: text().notNull(),
    revokedAt: integer({ mode: "timestamp_ms" }).notNull(),
    userId: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.authorizationCodeId, table.clientId, table.userId],
      name: "oauthRefreshTokenFamilyRevocation_pk",
    }),
    index("oauthRefreshTokenFamilyRevocation_userId_clientId_idx").on(
      table.userId,
      table.clientId,
    ),
    index("oauthRefreshTokenFamilyRevocation_revokedAt_idx").on(
      table.revokedAt,
    ),
  ],
)

export const maintenanceLeases = sqliteTable("maintenance_lease", {
  name: text().primaryKey(),
  ownerId: text().notNull(),
  expiresAt: integer().notNull(),
})

export const databaseBackupHealth = sqliteTable(
  "database_backup_health",
  {
    name: text().primaryKey(),
    status: text().$type<"failed" | "ok">().notNull(),
    runId: text().notNull(),
    startedAt: integer().notNull(),
    completedAt: integer().notNull(),
    lastSuccessAt: integer(),
    failureCode: text().$type<DatabaseBackupErrorCode>(),
  },
  (table) => [
    check(
      "database_backup_health_name_check",
      sql`${table.name} = 'database-backup'`,
    ),
    check(
      "database_backup_health_status_check",
      sql`${table.status} IN ('failed', 'ok')`,
    ),
    check(
      "database_backup_health_time_check",
      sql`${table.startedAt} BETWEEN 0 AND 8640000000000000 AND ${table.completedAt} BETWEEN ${table.startedAt} AND 8640000000000000 AND (${table.lastSuccessAt} IS NULL OR ${table.lastSuccessAt} BETWEEN 0 AND 8640000000000000)`,
    ),
    check(
      "database_backup_health_terminal_check",
      sql`(${table.status} = 'ok' AND ${table.failureCode} IS NULL AND ${table.lastSuccessAt} IS NOT NULL) OR (${table.status} = 'failed' AND ${table.failureCode} IS NOT NULL)`,
    ),
  ],
)

export const securityAuditEvents = sqliteTable(
  "security_audit_events",
  {
    id: text().primaryKey(),
    type: text().notNull(),
    outcome: text().notNull(),
    occurredAt: integer().notNull(),
    subjectId: text(),
    credentialId: text(),
    clientId: text(),
    ipFingerprint: text(),
    requestId: text().notNull(),
    metadata: text(),
  },
  (table) => [
    index("security_audit_events_occurredAt_id_idx").on(
      desc(table.occurredAt),
      desc(table.id),
    ),
    index("security_audit_events_outcome_occurredAt_id_idx").on(
      table.outcome,
      desc(table.occurredAt),
      desc(table.id),
    ),
    index("security_audit_events_type_occurredAt_id_idx").on(
      table.type,
      desc(table.occurredAt),
      desc(table.id),
    ),
    index("security_audit_events_type_outcome_occurredAt_id_idx").on(
      table.type,
      table.outcome,
      desc(table.occurredAt),
      desc(table.id),
    ),
  ],
)

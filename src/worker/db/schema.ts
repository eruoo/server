import { desc, sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

import type {
  AiConnectionAuthorizationStatus,
  AiAuthorizationSessionStatus,
  AiInvocationStatus,
} from "../../shared/ai"
import type { DatabaseBackupErrorCode } from "../backup/errors"

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

// The four AI application tables mirror migrations/0002_ai_service.sql. The
// migration SQL is the authoritative DDL; these declarations are the typed
// application model. AI HTTP routes and connectors are not open yet.
export const aiConnections = sqliteTable(
  "ai_connections",
  {
    id: text().primaryKey(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    providerType: text().notNull(),
    enabled: integer().notNull(),
    authorizationStatus: text()
      .$type<AiConnectionAuthorizationStatus>()
      .notNull(),
    upstreamAccountId: text(),
    credentialVersion: integer().notNull(),
    credentialCiphertext: text(),
    credentialExpiresAt: integer(),
    refreshClaimId: text(),
    refreshClaimExpiresAt: integer(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [
    check(
      "ai_connections_slug_format_check",
      sql`length(${table.slug}) BETWEEN 1 AND 64 AND ${table.slug} NOT GLOB '*[^a-z0-9-]*' AND ${table.slug} NOT GLOB '-*' AND ${table.slug} NOT GLOB '*-' AND ${table.slug} NOT GLOB '*--*'`,
    ),
    check("ai_connections_enabled_check", sql`${table.enabled} IN (0, 1)`),
    check(
      "ai_connections_authorization_status_check",
      sql`${table.authorizationStatus} IN ('never_authorized', 'connected', 'reauthentication_required')`,
    ),
    check(
      "ai_connections_credential_presence_check",
      sql`(${table.authorizationStatus} = 'connected' AND ${table.credentialCiphertext} IS NOT NULL AND ${table.credentialExpiresAt} IS NOT NULL) OR (${table.authorizationStatus} <> 'connected' AND ${table.credentialCiphertext} IS NULL AND ${table.credentialExpiresAt} IS NULL)`,
    ),
    check(
      "ai_connections_refresh_claim_pair_check",
      sql`(${table.refreshClaimId} IS NULL AND ${table.refreshClaimExpiresAt} IS NULL) OR (${table.refreshClaimId} IS NOT NULL AND ${table.refreshClaimExpiresAt} IS NOT NULL)`,
    ),
    check(
      "ai_connections_credential_version_check",
      sql`${table.credentialVersion} >= 0`,
    ),
    check(
      "ai_connections_time_check",
      sql`${table.createdAt} BETWEEN 0 AND 8640000000000000 AND ${table.updatedAt} BETWEEN ${table.createdAt} AND 8640000000000000`,
    ),
  ],
)

export const aiAuthorizationSessions = sqliteTable(
  "ai_authorization_sessions",
  {
    id: text().primaryKey(),
    connectionId: text()
      .notNull()
      .references(() => aiConnections.id, { onDelete: "cascade" }),
    ownerUserId: text().notNull(),
    ownerSessionId: text().notNull(),
    connectionCredentialVersion: integer().notNull(),
    status: text().$type<AiAuthorizationSessionStatus>().notNull(),
    deviceGrantCiphertext: text().notNull(),
    expiresAt: integer().notNull(),
    nextPollAt: integer().notNull(),
    pollClaimId: text(),
    pollClaimExpiresAt: integer(),
    completionId: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [
    check(
      "ai_authorization_sessions_status_check",
      sql`${table.status} IN ('pending', 'completed', 'cancelled')`,
    ),
    check(
      "ai_authorization_sessions_completion_check",
      sql`(${table.status} = 'completed' AND ${table.completionId} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.completionId} IS NULL)`,
    ),
    check(
      "ai_authorization_sessions_poll_claim_pair_check",
      sql`(${table.pollClaimId} IS NULL AND ${table.pollClaimExpiresAt} IS NULL) OR (${table.pollClaimId} IS NOT NULL AND ${table.pollClaimExpiresAt} IS NOT NULL)`,
    ),
    check(
      "ai_authorization_sessions_version_check",
      sql`${table.connectionCredentialVersion} >= 0`,
    ),
    check(
      "ai_authorization_sessions_time_check",
      sql`${table.createdAt} BETWEEN 0 AND 8640000000000000 AND ${table.updatedAt} BETWEEN ${table.createdAt} AND 8640000000000000 AND ${table.expiresAt} > ${table.createdAt} AND ${table.nextPollAt} >= ${table.createdAt}`,
    ),
    index("ai_authorization_sessions_connectionId_idx").on(table.connectionId),
    index("ai_authorization_sessions_expiresAt_idx").on(table.expiresAt),
  ],
)

export const aiModels = sqliteTable(
  "ai_models",
  {
    connectionId: text()
      .notNull()
      .references(() => aiConnections.id, { onDelete: "cascade" }),
    upstreamModelId: text().notNull(),
    displayName: text(),
    capabilities: text(),
    snapshotCredentialVersion: integer().notNull(),
    discoveredAt: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.upstreamModelId] }),
    check(
      "ai_models_version_check",
      sql`${table.snapshotCredentialVersion} >= 0`,
    ),
    check(
      "ai_models_discoveredAt_check",
      sql`${table.discoveredAt} BETWEEN 0 AND 8640000000000000`,
    ),
  ],
)

export const aiInvocations = sqliteTable(
  "ai_invocations",
  {
    requestId: text().primaryKey(),
    apiKeyId: text().notNull(),
    connectionId: text().notNull(),
    upstreamModelId: text().notNull(),
    startedAt: integer().notNull(),
    deadlineAt: integer().notNull(),
    leaseExpiresAt: integer().notNull(),
    status: text().$type<AiInvocationStatus>().notNull(),
    endedAt: integer(),
    errorCode: text(),
    upstreamRequestId: text(),
    usage: text(),
  },
  (table) => [
    check(
      "ai_invocations_status_check",
      sql`${table.status} IN ('reserved', 'succeeded', 'failed', 'incomplete', 'unknown')`,
    ),
    check(
      "ai_invocations_terminal_ended_check",
      sql`(${table.status} = 'reserved' AND ${table.endedAt} IS NULL) OR (${table.status} <> 'reserved' AND ${table.endedAt} IS NOT NULL)`,
    ),
    check(
      "ai_invocations_time_check",
      sql`${table.startedAt} BETWEEN 0 AND 8640000000000000 AND ${table.deadlineAt} > ${table.startedAt} AND ${table.leaseExpiresAt} >= ${table.deadlineAt} AND (${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt})`,
    ),
    index("ai_invocations_startedAt_requestId_idx").on(
      desc(table.startedAt),
      desc(table.requestId),
    ),
    index("ai_invocations_inflight_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'reserved'`),
    index("ai_invocations_inflight_apiKey_lease_idx")
      .on(table.apiKeyId, table.leaseExpiresAt)
      .where(sql`${table.status} = 'reserved'`),
  ],
)

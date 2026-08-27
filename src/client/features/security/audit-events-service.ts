import { apiClient, type EruooApiClient } from "@client/lib/api-client"
import {
  ApiResponseError,
  hasExactKeys,
  isNonnegativeInteger,
  isRecord,
  readApiJson,
} from "@client/lib/api-response"

import type { paths } from "../../../../.generated/openapi"

type AuditQueryContract = NonNullable<
  paths["/api/security/audit-events"]["get"]["parameters"]["query"]
>
type AuditEventContract =
  paths["/api/security/audit-events"]["get"]["responses"][200]["content"]["application/json"]["events"][number]

export type AuditEventType = NonNullable<AuditQueryContract["type"]>
export type AuditOutcome = NonNullable<AuditQueryContract["outcome"]>

export type SecurityAuditEvent = Readonly<
  Omit<AuditEventContract, "metadata">
> & {
  readonly metadata: Readonly<Record<string, boolean | number | string>> | null
}

export interface AuditEventFilters {
  from?: number
  limit: number
  outcome?: AuditOutcome
  to?: number
  type?: AuditEventType
}

export interface AuditEventPageRequest extends AuditEventFilters {
  cursor?: string
}

export interface AuditEventPage {
  readonly events: readonly SecurityAuditEvent[]
  readonly nextCursor: string | null
}

export interface AuditEventsService {
  list(request: AuditEventPageRequest): Promise<AuditEventPage>
}

export const defaultAuditPageSize = 50

export const auditEventTypeLabels = {
  api_key_created: "API Key 已创建",
  api_key_expired: "API Key 已过期",
  api_key_rejected: "API Key 被拒绝",
  api_key_revoked: "API Key 已撤销",
  api_key_updated: "API Key 已更新",
  database_restore_completed: "数据库恢复完成",
  github_login: "GitHub 登录",
  jwt_signing_key_rotated: "JWT 签名密钥已轮换",
  oauth_grant_created: "OAuth 授权已创建",
  oauth_grant_revoked: "OAuth 授权已撤销",
  oauth_refresh_reuse_detected: "检测到 refresh token 重用",
  passkey_created: "Passkey 已创建",
  passkey_deleted: "Passkey 已删除",
  passkey_login: "Passkey 登录",
  passkey_updated: "Passkey 已更新",
  security_configuration_changed: "安全配置已变更",
  sensitive_operation_denied: "敏感操作被拒绝",
} as const satisfies Record<AuditEventType, string>

export const auditOutcomeLabels = {
  failure: "失败",
  success: "成功",
} as const satisfies Record<AuditOutcome, string>

const auditEventKeys = [
  "clientId",
  "credentialId",
  "id",
  "ipFingerprint",
  "metadata",
  "occurredAt",
  "outcome",
  "requestId",
  "subjectId",
  "type",
] as const

const auditPageKeys = ["events", "nextCursor"] as const
const auditEventTypeSet = new Set<string>(Object.keys(auditEventTypeLabels))
const maximumDateTimestamp = 8_640_000_000_000_000
const opaqueCursorPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export { ApiResponseError as AuditEventsApiError }

function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === "string" && auditEventTypeSet.has(value)
}

function isAuditOutcome(value: unknown): value is AuditOutcome {
  return value === "failure" || value === "success"
}

function isNullableNonemptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0)
}

function isOpaqueCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    opaqueCursorPattern.test(value)
  )
}

function parseMetadata(
  value: unknown,
): Readonly<Record<string, boolean | number | string>> | null {
  if (value === null) return null
  if (!isRecord(value)) {
    throw new ApiResponseError("Audit event metadata is invalid.")
  }

  const metadata: Record<string, boolean | number | string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      !(
        typeof item === "boolean" ||
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item))
      )
    ) {
      throw new ApiResponseError("Audit event metadata is invalid.")
    }
    metadata[key] = item
  }

  return metadata
}

function parseAuditEvent(value: unknown): SecurityAuditEvent {
  if (!isRecord(value) || !hasExactKeys(value, auditEventKeys)) {
    throw new ApiResponseError("Audit event response is invalid.")
  }

  const clientId = value["clientId"]
  const credentialId = value["credentialId"]
  const id = value["id"]
  const ipFingerprint = value["ipFingerprint"]
  const occurredAt = value["occurredAt"]
  const outcome = value["outcome"]
  const requestId = value["requestId"]
  const subjectId = value["subjectId"]
  const type = value["type"]

  if (
    !isNullableNonemptyString(clientId) ||
    !isNullableNonemptyString(credentialId) ||
    typeof id !== "string" ||
    id.length === 0 ||
    !(
      ipFingerprint === null ||
      (typeof ipFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(ipFingerprint))
    ) ||
    !isNonnegativeInteger(occurredAt) ||
    occurredAt > maximumDateTimestamp ||
    !isAuditOutcome(outcome) ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    !isNullableNonemptyString(subjectId) ||
    !isAuditEventType(type)
  ) {
    throw new ApiResponseError("Audit event state is invalid.")
  }

  return {
    clientId,
    credentialId,
    id,
    ipFingerprint,
    metadata: parseMetadata(value["metadata"]),
    occurredAt,
    outcome,
    requestId,
    subjectId,
    type,
  }
}

function validateRequest(request: AuditEventPageRequest): void {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > 100 ||
    (request.from !== undefined && !isNonnegativeInteger(request.from)) ||
    (request.to !== undefined && !isNonnegativeInteger(request.to)) ||
    (request.from !== undefined &&
      request.to !== undefined &&
      request.from > request.to) ||
    (request.outcome !== undefined && !isAuditOutcome(request.outcome)) ||
    (request.type !== undefined && !isAuditEventType(request.type)) ||
    (request.cursor !== undefined && !isOpaqueCursor(request.cursor))
  ) {
    throw new ApiResponseError("Audit event query is invalid.")
  }
}

function eventMatchesRequest(
  event: SecurityAuditEvent,
  request: AuditEventPageRequest,
): boolean {
  return !(
    (request.from !== undefined && event.occurredAt < request.from) ||
    (request.to !== undefined && event.occurredAt > request.to) ||
    (request.outcome !== undefined && event.outcome !== request.outcome) ||
    (request.type !== undefined && event.type !== request.type)
  )
}

function isDescendingPage(events: readonly SecurityAuditEvent[]): boolean {
  return events.every((event, index) => {
    const preceding = events[index - 1]
    if (preceding === undefined) return true
    if (preceding.occurredAt !== event.occurredAt) {
      return preceding.occurredAt > event.occurredAt
    }

    return preceding.id > event.id
  })
}

function parseAuditPage(
  value: unknown,
  request: AuditEventPageRequest,
): AuditEventPage {
  if (!isRecord(value) || !hasExactKeys(value, auditPageKeys)) {
    throw new ApiResponseError("Audit event page response is invalid.")
  }

  if (!Array.isArray(value["events"])) {
    throw new ApiResponseError("Audit event list is invalid.")
  }

  const events = value["events"].map(parseAuditEvent)
  const nextCursor = value["nextCursor"]
  const eventIds = new Set(events.map(({ id }) => id))

  if (
    !(nextCursor === null || isOpaqueCursor(nextCursor)) ||
    nextCursor === request.cursor ||
    events.length > request.limit ||
    (nextCursor !== null && events.length !== request.limit) ||
    eventIds.size !== events.length ||
    !events.every((event) => eventMatchesRequest(event, request)) ||
    !isDescendingPage(events)
  ) {
    throw new ApiResponseError("Audit event page invariants are invalid.")
  }

  return { events, nextCursor }
}

function toQuery(request: AuditEventPageRequest): AuditQueryContract {
  return {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.from === undefined ? {} : { from: request.from }),
    limit: request.limit,
    ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.type === undefined ? {} : { type: request.type }),
  }
}

export function createAuditEventsService(
  client: EruooApiClient = apiClient,
): AuditEventsService {
  return {
    async list(request) {
      validateRequest(request)

      return readApiJson(
        () =>
          client.GET("/api/security/audit-events", {
            params: { query: toQuery(request) },
          }),
        (value) => parseAuditPage(value, request),
      )
    },
  }
}

export const auditEventsService = createAuditEventsService()

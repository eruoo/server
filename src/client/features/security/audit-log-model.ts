import {
  defaultAuditPageSize,
  type AuditEventFilters,
  type AuditEventType,
  type AuditOutcome,
} from "@client/features/security/audit-events-service"

const shanghaiOffsetMilliseconds = 8 * 60 * 60 * 1000
const dateTimeLocalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  hourCycle: "h23",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
})

export type AuditPageSize = 25 | 50 | 100

export interface AuditFilterDraft {
  from: string
  limit: AuditPageSize
  outcome: "" | AuditOutcome
  to: string
  type: "" | AuditEventType
}

export const defaultAuditFilterDraft: Readonly<AuditFilterDraft> = {
  from: "",
  limit: defaultAuditPageSize,
  outcome: "",
  to: "",
  type: "",
}

export function parseShanghaiDateTime(value: string): number | undefined {
  if (!dateTimeLocalPattern.test(value)) return undefined

  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const hour = Number(value.slice(11, 13))
  const minute = Number(value.slice(14, 16))
  const timestamp =
    Date.UTC(year, month - 1, day, hour, minute) - shanghaiOffsetMilliseconds
  const localRepresentation = new Date(timestamp + shanghaiOffsetMilliseconds)

  if (
    timestamp < 0 ||
    localRepresentation.getUTCFullYear() !== year ||
    localRepresentation.getUTCMonth() !== month - 1 ||
    localRepresentation.getUTCDate() !== day ||
    localRepresentation.getUTCHours() !== hour ||
    localRepresentation.getUTCMinutes() !== minute
  ) {
    return undefined
  }

  return timestamp
}

export function normalizeAuditFilterDraft(
  draft: Readonly<AuditFilterDraft>,
): AuditEventFilters | undefined {
  const from = draft.from === "" ? undefined : parseShanghaiDateTime(draft.from)
  const to = draft.to === "" ? undefined : parseShanghaiDateTime(draft.to)

  if (
    (draft.from !== "" && from === undefined) ||
    (draft.to !== "" && to === undefined) ||
    (from !== undefined && to !== undefined && from > to)
  ) {
    return undefined
  }

  return {
    ...(from === undefined ? {} : { from }),
    limit: draft.limit,
    ...(draft.outcome === "" ? {} : { outcome: draft.outcome }),
    ...(to === undefined ? {} : { to }),
    ...(draft.type === "" ? {} : { type: draft.type }),
  }
}

export function formatAuditTimestamp(timestamp: number): string {
  return `${shanghaiDateTimeFormatter.format(timestamp)} · UTC+8`
}

export function formatAuditMetadata(
  metadata: Readonly<Record<string, boolean | number | string>>,
): string {
  const orderedMetadata = Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )

  return JSON.stringify(orderedMetadata, null, 2)
}

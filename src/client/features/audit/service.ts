import { requestJson } from "../../lib/http"
export interface AuditEvent {
  id: string
  type: string
  outcome: "success" | "failure"
  occurredAt: number
  requestId: string
  subjectId: string | null
}
export interface AuditPage {
  events: AuditEvent[]
  nextCursor: string | null
}
export function getAuditEvents(
  filters: { outcome?: string; from?: string; to?: string },
  cursor: string | null,
  signal: AbortSignal,
) {
  const params = new URLSearchParams()
  if (filters.outcome) params.set("outcome", filters.outcome)
  if (filters.from) params.set("from", String(new Date(filters.from).getTime()))
  if (filters.to) params.set("to", String(new Date(filters.to).getTime()))
  if (cursor) params.set("cursor", cursor)
  return requestJson<AuditPage>(`/api/security/audit-events?${params}`, {
    signal,
  })
}

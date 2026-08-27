import {
  AuditEventsApiError,
  createAuditEventsService,
  type SecurityAuditEvent,
} from "@client/features/security/audit-events-service"
import {
  createEruooApiClient,
  type EruooApiFetch,
} from "@client/lib/api-client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const newerTimestamp = Date.parse("2026-08-21T03:04:05.000Z")
const olderTimestamp = newerTimestamp - 1_000

function event(input: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    clientId: "eruoo-desktop",
    credentialId: null,
    id: "event-z",
    ipFingerprint: "a".repeat(64),
    metadata: { attempt: 1, interactive: true },
    occurredAt: newerTimestamp,
    outcome: "failure",
    requestId: "request-z",
    subjectId: "owner-id",
    type: "sensitive_operation_denied",
    ...input,
  }
}

function jsonResponse(
  body: unknown,
  options: { contentType?: string; status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": options.contentType ?? "application/json",
    },
    status: options.status ?? 200,
  })
}

describe("audit events service", () => {
  const fetcher = vi.fn<EruooApiFetch>()
  const service = createAuditEventsService(createEruooApiClient(fetcher))

  beforeEach(() => {
    fetcher.mockReset()
  })

  it("sends typed filters and returns a strictly parsed cursor page", async () => {
    const events = [
      event(),
      event({ id: "event-y", occurredAt: olderTimestamp }),
    ]
    fetcher.mockResolvedValue(
      jsonResponse({ events, nextCursor: "opaque_payload.signature" }),
    )

    const page = await service.list({
      from: olderTimestamp,
      limit: 2,
      outcome: "failure",
      to: newerTimestamp,
      type: "sensitive_operation_denied",
    })

    expect(page).toEqual({
      events,
      nextCursor: "opaque_payload.signature",
    })
    const request = fetcher.mock.calls[0]?.[0]
    expect(request?.method).toBe("GET")
    expect(request?.credentials).toBe("include")
    expect(request?.headers.get("accept")).toBe(
      "application/json, application/problem+json",
    )

    const url = new URL(request?.url ?? "https://invalid.test")
    expect(url.pathname).toBe("/api/security/audit-events")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: String(olderTimestamp),
      limit: "2",
      outcome: "failure",
      to: String(newerTimestamp),
      type: "sensitive_operation_denied",
    })
  })

  it("returns the opaque cursor unchanged on the next request", async () => {
    fetcher.mockResolvedValue(jsonResponse({ events: [], nextCursor: null }))

    await service.list({
      cursor: "opaque_payload.signature",
      limit: 50,
    })

    const url = new URL(
      fetcher.mock.calls[0]?.[0].url ?? "https://invalid.test",
    )
    expect(url.searchParams.get("cursor")).toBe("opaque_payload.signature")
  })

  it("fails closed on extra fields and page invariant violations", async () => {
    fetcher.mockResolvedValueOnce(
      jsonResponse({
        events: [{ ...event(), unexpected: true }],
        nextCursor: null,
      }),
    )

    await expect(service.list({ limit: 1 })).rejects.toThrow(
      "Audit event response is invalid.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse({
        events: [event()],
        nextCursor: "opaque_payload.signature",
      }),
    )

    await expect(service.list({ limit: 2 })).rejects.toThrow(
      "Audit event page invariants are invalid.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse({
        events: [
          event({ id: "event-a", occurredAt: olderTimestamp }),
          event({ id: "event-b", occurredAt: newerTimestamp }),
        ],
        nextCursor: null,
      }),
    )

    await expect(service.list({ limit: 2 })).rejects.toThrow(
      "Audit event page invariants are invalid.",
    )
  })

  it("rejects events that do not match the active filters", async () => {
    fetcher.mockResolvedValue(
      jsonResponse({
        events: [event({ outcome: "success" })],
        nextCursor: null,
      }),
    )

    await expect(
      service.list({ limit: 50, outcome: "failure" }),
    ).rejects.toThrow("Audit event page invariants are invalid.")
  })

  it("preserves only a valid Problem response", async () => {
    fetcher.mockResolvedValue(
      jsonResponse(
        {
          detail: "The audit cursor is invalid.",
          errors: [
            {
              detail: "Use a cursor returned for the current filter set.",
              location: "query",
              pointer: "/cursor",
            },
          ],
          requestId: "synthetic-request-id",
          status: 422,
          title: "Validation failed",
          type: "https://auth.eruoo.me/problems/validation-failed",
        },
        { contentType: "application/problem+json", status: 422 },
      ),
    )

    let thrown: unknown
    try {
      await service.list({ limit: 50 })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AuditEventsApiError)
    expect(thrown).toMatchObject({
      problem: {
        requestId: "synthetic-request-id",
        status: 422,
        type: "https://auth.eruoo.me/problems/validation-failed",
      },
      status: 422,
    })
  })

  it("does not trust malformed JSON, media types, or Problem status", async () => {
    fetcher.mockResolvedValueOnce(
      new Response("not-json", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    )
    await expect(service.list({ limit: 50 })).rejects.toThrow(
      "API response is not valid JSON.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        { events: [], nextCursor: null },
        { contentType: "text/plain" },
      ),
    )
    await expect(service.list({ limit: 50 })).rejects.toThrow(
      "API success response is invalid.",
    )

    fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          detail: "Mismatched status must not be trusted.",
          requestId: "synthetic-request-id",
          status: 401,
          title: "Authentication required",
          type: "https://auth.eruoo.me/problems/authentication-required",
        },
        { contentType: "application/problem+json", status: 422 },
      ),
    )
    await expect(service.list({ limit: 50 })).rejects.toThrow(
      "API Problem is invalid.",
    )
  })

  it("rejects invalid queries before issuing a request", async () => {
    await expect(service.list({ limit: 101 })).rejects.toThrow(
      "Audit event query is invalid.",
    )
    await expect(
      service.list({ from: newerTimestamp, limit: 50, to: olderTimestamp }),
    ).rejects.toThrow("Audit event query is invalid.")
    expect(fetcher).not.toHaveBeenCalled()
  })
})

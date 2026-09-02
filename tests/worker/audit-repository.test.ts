import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS,
} from "../../src/shared/api-key"
import {
  deleteExpiredAuditEvents,
  InvalidAuditCursorError,
  InvalidStoredAuditEventError,
  listAuditEvents,
} from "../../src/worker/modules/audit/repository"

const cursorSecret = "synthetic-audit-cursor-secret-used-only-in-tests"
const now = 2_000_000_000_000
const day = 24 * 60 * 60 * 1000

interface TestAuditEvent {
  id: string
  occurredAt: number
  outcome?: "failure" | "success"
  type?: "github_login_succeeded" | "passkey_created"
}

async function insertEvents(events: TestAuditEvent[]) {
  await env.DB.batch(
    events.map((event) =>
      env.DB.prepare(
        `INSERT INTO security_audit_events
          (id, type, outcome, occurredAt, requestId, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        event.type ?? "passkey_created",
        event.outcome ?? "success",
        event.occurredAt,
        `request-${event.id}`,
        JSON.stringify({ source: "test" }),
      ),
    ),
  )
}

describe("audit event repository", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM security_audit_events").run()
  })

  it("paginates in a stable descending order without overlap", async () => {
    await insertEvents([
      { id: "event-a", occurredAt: now - 1_000 },
      { id: "event-c", occurredAt: now - 1_000 },
      { id: "event-b", occurredAt: now - 1_000 },
      { id: "event-old", occurredAt: now - 2_000 },
    ])

    const firstPage = await listAuditEvents(env.DB, cursorSecret, {
      limit: 2,
      now,
    })
    const secondPage = await listAuditEvents(env.DB, cursorSecret, {
      cursor: firstPage.nextCursor!,
      limit: 2,
      now,
    })

    expect(firstPage.events.map((event) => event.id)).toEqual([
      "event-c",
      "event-b",
    ])
    expect(firstPage.events[0]?.metadata).toEqual({ source: "test" })
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    expect(secondPage.events.map((event) => event.id)).toEqual([
      "event-a",
      "event-old",
    ])
    expect(secondPage.nextCursor).toBeNull()
  })

  it("binds signed cursors to the active filters", async () => {
    await insertEvents([
      { id: "event-b", occurredAt: now - 1_000 },
      { id: "event-a", occurredAt: now - 2_000 },
    ])

    const firstPage = await listAuditEvents(env.DB, cursorSecret, {
      limit: 1,
      now,
      outcome: "success",
    })
    const cursor = firstPage.nextCursor

    expect(cursor).not.toBeNull()
    await expect(
      listAuditEvents(env.DB, cursorSecret, {
        cursor: cursor!,
        limit: 1,
        now,
        outcome: "failure",
      }),
    ).rejects.toBeInstanceOf(InvalidAuditCursorError)
  })

  it("rejects a tampered cursor", async () => {
    await insertEvents([
      { id: "event-b", occurredAt: now - 1_000 },
      { id: "event-a", occurredAt: now - 2_000 },
    ])

    const firstPage = await listAuditEvents(env.DB, cursorSecret, {
      limit: 1,
      now,
    })
    const cursor = firstPage.nextCursor

    expect(cursor).not.toBeNull()
    const tamperedCursor = `${cursor?.slice(0, -1)}x`
    await expect(
      listAuditEvents(env.DB, cursorSecret, {
        cursor: tamperedCursor,
        limit: 1,
        now,
      }),
    ).rejects.toBeInstanceOf(InvalidAuditCursorError)
  })

  it("enforces the logical retention boundary while listing", async () => {
    await insertEvents([
      { id: "inside", occurredAt: now - 180 * day },
      { id: "expired", occurredAt: now - 180 * day - 1 },
    ])

    const page = await listAuditEvents(env.DB, cursorSecret, { now })

    expect(page.events.map((event) => event.id)).toEqual(["inside"])
  })

  it("physically deletes only events older than the retention boundary", async () => {
    await insertEvents([
      { id: "inside", occurredAt: now - 180 * day },
      { id: "expired", occurredAt: now - 180 * day - 1 },
    ])

    await expect(deleteExpiredAuditEvents(env.DB, now)).resolves.toBe(1)
    const rows = await env.DB.prepare(
      "SELECT id FROM security_audit_events ORDER BY id",
    ).all<{ id: string }>()

    expect(rows.results).toEqual([{ id: "inside" }])
  })

  it("uses the ordered time index for physical cleanup", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       DELETE FROM security_audit_events
       WHERE occurredAt < ?`,
    )
      .bind(now - 180 * day)
      .all<{ detail: string }>()
    const details = plan.results.map(({ detail }) => detail).join("\n")

    expect(details).toContain("security_audit_events_occurredAt_id_idx")
    expect(details).not.toContain("SCAN security_audit_events")
  })

  it("keeps the single-bucket indexed audit model below half the D1 Free write baseline", async () => {
    const indexes = await env.DB.prepare(
      `SELECT name
       FROM pragma_index_list('security_audit_events')
       ORDER BY name`,
    ).all<{ name: string }>()
    const expectedIndexes = [
      "security_audit_events_occurredAt_id_idx",
      "security_audit_events_outcome_occurredAt_id_idx",
      "security_audit_events_type_occurredAt_id_idx",
      "security_audit_events_type_outcome_occurredAt_id_idx",
      "sqlite_autoindex_security_audit_events_1",
    ]
    const windowsPerDay =
      (24 * 60 * 60) / API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS
    const minimumRowsWrittenPerAudit = 1 + indexes.results.length
    const modeledIndexedAuditRowsWrittenPerDay =
      API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS *
      windowsPerDay *
      minimumRowsWrittenPerAudit

    expect(indexes.results.map(({ name }) => name)).toEqual(expectedIndexes)
    expect(modeledIndexedAuditRowsWrittenPerDay).toBeLessThanOrEqual(50_000)
  })

  it("rejects invalid page and time bounds", async () => {
    await expect(
      listAuditEvents(env.DB, cursorSecret, { limit: 0, now }),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      listAuditEvents(env.DB, cursorSecret, { from: now, now, to: now - 1 }),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it("rejects an undersized cursor HMAC secret", async () => {
    await expect(listAuditEvents(env.DB, "too-short", { now })).rejects.toThrow(
      "at least 32 UTF-8 bytes",
    )
  })

  it.each([
    { column: "outcome", value: "unknown" },
    { column: "type", value: "unknown" },
    { column: "metadata", value: "not-json" },
  ])("rejects invalid stored $column data", async ({ column, value }) => {
    await insertEvents([{ id: "corrupt", occurredAt: now - 1_000 }])
    await env.DB.prepare(
      `UPDATE security_audit_events SET ${column} = ? WHERE id = ?`,
    )
      .bind(value, "corrupt")
      .run()

    await expect(
      listAuditEvents(env.DB, cursorSecret, { now }),
    ).rejects.toBeInstanceOf(InvalidStoredAuditEventError)
  })

  it("uses the ordered type index for a type-only filter", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT *
       FROM security_audit_events
       WHERE type = ? AND occurredAt >= ?
       ORDER BY occurredAt DESC, id DESC
       LIMIT 51`,
    )
      .bind("passkey_created", now - 180 * day)
      .all<{ detail: string }>()

    expect(plan.results.map(({ detail }) => detail).join("\n")).toContain(
      "security_audit_events_type_occurredAt_id_idx",
    )
    expect(plan.results.map(({ detail }) => detail).join("\n")).not.toContain(
      "USE TEMP B-TREE",
    )
  })
})

import {
  formatAuditMetadata,
  formatAuditTimestamp,
  normalizeAuditFilterDraft,
  parseShanghaiDateTime,
} from "@client/features/security/audit-log-model"
import { describe, expect, it } from "vitest"

describe("audit log date and display model", () => {
  it("interprets datetime-local input as fixed Asia/Shanghai time", () => {
    expect(parseShanghaiDateTime("2026-08-21T11:04")).toBe(
      Date.parse("2026-08-21T03:04:00.000Z"),
    )
    expect(parseShanghaiDateTime("2026-02-29T11:04")).toBeUndefined()
    expect(parseShanghaiDateTime("1969-12-31T23:59")).toBeUndefined()
    expect(parseShanghaiDateTime("not-a-date")).toBeUndefined()
  })

  it("normalizes optional filters and rejects reversed ranges", () => {
    expect(
      normalizeAuditFilterDraft({
        from: "2026-08-21T11:04",
        limit: 25,
        outcome: "failure",
        to: "2026-08-21T12:04",
        type: "sensitive_operation_denied",
      }),
    ).toEqual({
      from: Date.parse("2026-08-21T03:04:00.000Z"),
      limit: 25,
      outcome: "failure",
      to: Date.parse("2026-08-21T04:04:00.000Z"),
      type: "sensitive_operation_denied",
    })

    expect(
      normalizeAuditFilterDraft({
        from: "2026-08-21T12:04",
        limit: 50,
        outcome: "",
        to: "2026-08-21T11:04",
        type: "",
      }),
    ).toBeUndefined()
  })

  it("formats timestamps in Shanghai and metadata deterministically", () => {
    const formatted = formatAuditTimestamp(
      Date.parse("2026-08-21T03:04:05.000Z"),
    )

    expect(formatted).toContain("11:04:05")
    expect(formatted).toContain("UTC+8")
    expect(formatAuditMetadata({ zebra: true, alpha: 1 })).toBe(
      '{\n  "alpha": 1,\n  "zebra": true\n}',
    )
  })
})

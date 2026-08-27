import {
  AuditEventsApiError,
  type AuditEventPage,
  type AuditEventPageRequest,
  type SecurityAuditEvent,
} from "@client/features/security/audit-events-service"
import AuditLogPanel from "@client/features/security/AuditLogPanel.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const serviceMocks = vi.hoisted(() => ({
  list: vi.fn<(request: AuditEventPageRequest) => Promise<AuditEventPage>>(),
}))

vi.mock(
  "@client/features/security/audit-events-service",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@client/features/security/audit-events-service")
      >()

    return {
      ...original,
      auditEventsService: serviceMocks,
    }
  },
)

function event(input: Partial<SecurityAuditEvent> = {}): SecurityAuditEvent {
  return {
    clientId: "eruoo-desktop",
    credentialId: null,
    id: "event-z",
    ipFingerprint: "a".repeat(64),
    metadata: { interactive: true },
    occurredAt: Date.parse("2026-08-21T03:04:05.000Z"),
    outcome: "failure",
    requestId: "request-z",
    subjectId: "owner-id",
    type: "sensitive_operation_denied",
    ...input,
  }
}

function buttonWithText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper
    .findAll("button")
    .find((item) => item.text().includes(text))
  if (button === undefined) throw new Error(`Button not found: ${text}`)
  return button
}

describe("AuditLogPanel", () => {
  beforeEach(() => {
    serviceMocks.list.mockReset()
  })

  it("loads and presents verified events in the brutal security view", async () => {
    serviceMocks.list.mockResolvedValue({ events: [event()], nextCursor: null })
    const wrapper = mount(AuditLogPanel)

    await flushPromises()

    expect(serviceMocks.list).toHaveBeenCalledWith({ limit: 50 })
    expect(wrapper.get("h1").text()).toBe("安全审计")
    expect(wrapper.get(".audit-event-card").text()).toContain("敏感操作被拒绝")
    expect(wrapper.get(".audit-event-card").text()).toContain("11:04:05")
    expect(wrapper.get(".audit-event-card").text()).toContain("UTC+8")
    expect(wrapper.text()).toContain("第 1 页 · 1 条")

    wrapper.unmount()
  })

  it("applies type, outcome, Shanghai time, and page-size filters", async () => {
    serviceMocks.list.mockResolvedValue({ events: [], nextCursor: null })
    const wrapper = mount(AuditLogPanel)
    await flushPromises()

    const selects = wrapper.findAll("select")
    await selects[0]?.setValue("sensitive_operation_denied")
    await selects[1]?.setValue("failure")
    await selects[2]?.setValue("25")
    const dateInputs = wrapper.findAll('input[type="datetime-local"]')
    await dateInputs[0]?.setValue("2026-08-21T11:04")
    await dateInputs[1]?.setValue("2026-08-21T12:04")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(serviceMocks.list).toHaveBeenLastCalledWith({
      from: Date.parse("2026-08-21T03:04:00.000Z"),
      limit: 25,
      outcome: "failure",
      to: Date.parse("2026-08-21T04:04:00.000Z"),
      type: "sensitive_operation_denied",
    })

    wrapper.unmount()
  })

  it("uses opaque cursors for next page and keeps local previous-page history", async () => {
    const firstPage = {
      events: [event()],
      nextCursor: "opaque_payload.signature",
    }
    const secondPage = {
      events: [
        event({
          id: "event-y",
          occurredAt: Date.parse("2026-08-21T03:03:05.000Z"),
        }),
      ],
      nextCursor: null,
    }
    serviceMocks.list
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(firstPage)
    const wrapper = mount(AuditLogPanel, { attachTo: document.body })
    await flushPromises()

    await buttonWithText(wrapper, "下一页").trigger("click")
    await flushPromises()

    expect(serviceMocks.list).toHaveBeenLastCalledWith({
      cursor: "opaque_payload.signature",
      limit: 50,
    })
    expect(wrapper.text()).toContain("第 2 页 · 1 条")
    expect(document.activeElement).toBe(wrapper.get(".page-status").element)

    await buttonWithText(wrapper, "上一页").trigger("click")
    await flushPromises()

    expect(serviceMocks.list).toHaveBeenLastCalledWith({ limit: 50 })
    expect(wrapper.text()).toContain("第 1 页 · 1 条")

    wrapper.unmount()
  })

  it("blocks a reversed time range before making another request", async () => {
    serviceMocks.list.mockResolvedValue({ events: [], nextCursor: null })
    const wrapper = mount(AuditLogPanel)
    await flushPromises()

    const dateInputs = wrapper.findAll('input[type="datetime-local"]')
    await dateInputs[0]?.setValue("2026-08-21T12:04")
    await dateInputs[1]?.setValue("2026-08-21T11:04")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(serviceMocks.list).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "开始时间不晚于结束时间",
    )

    wrapper.unmount()
  })

  it("fails closed and retries the same request", async () => {
    serviceMocks.list
      .mockRejectedValueOnce(new Error("invalid response"))
      .mockResolvedValueOnce({ events: [event()], nextCursor: null })
    const wrapper = mount(AuditLogPanel)
    await flushPromises()

    expect(wrapper.text()).toContain("无法验证审计数据")
    expect(wrapper.find(".audit-event-card").exists()).toBe(false)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)

    await buttonWithText(wrapper, "重试").trigger("click")
    await flushPromises()

    expect(serviceMocks.list).toHaveBeenNthCalledWith(2, { limit: 50 })
    expect(wrapper.find(".audit-event-card").exists()).toBe(true)

    wrapper.unmount()
  })

  it("offers sign-in instead of retrying when the owner Session expires", async () => {
    serviceMocks.list.mockRejectedValue(
      new AuditEventsApiError("A valid owner Session is required.", {
        detail: "A valid owner Session is required.",
        requestId: "synthetic-request-id",
        status: 401,
        title: "Invalid credential",
        type: "https://auth.eruoo.me/problems/invalid-credential",
      }),
    )
    const wrapper = mount(AuditLogPanel, {
      global: {
        stubs: {
          RouterLink: {
            props: ["to"],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
    expect(wrapper.text()).not.toContain("服务暂时不可用")
    expect(wrapper.find("button").text()).not.toContain("重试")

    wrapper.unmount()
  })
})

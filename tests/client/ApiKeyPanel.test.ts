import ApiKeyPanel from "@client/features/security/ApiKeyPanel.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiKeyMocks = vi.hoisted(() => ({
  create: vi.fn<(input: unknown) => Promise<unknown>>(),
  delete: vi.fn<(input: { keyId: string }) => Promise<unknown>>(),
  getSession: vi.fn<() => Promise<unknown>>(),
  list: vi.fn<() => Promise<unknown>>(),
}))

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    apiKey: apiKeyMocks,
    getSession: apiKeyMocks.getSession,
  },
}))

describe("ApiKeyPanel", () => {
  beforeEach(() => {
    apiKeyMocks.create.mockReset()
    apiKeyMocks.delete.mockReset()
    apiKeyMocks.getSession.mockReset()
    apiKeyMocks.list.mockReset()
  })

  it("offers only the configured status:read key in the empty state", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("还没有 API Key")
    expect(wrapper.text()).toContain("status:read")
    expect(wrapper.get('button[type="submit"]').text()).toBe("创建")
    expect(apiKeyMocks.getSession).not.toHaveBeenCalled()
  })

  it("creates a finite scoped key and renders the raw value only once", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    apiKeyMocks.create.mockResolvedValue({
      data: { key: "eruoo_one_time_raw_key" },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("status-cli")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(apiKeyMocks.create).toHaveBeenCalledWith({
      expiresIn: 180 * 24 * 60 * 60,
      name: "status-cli",
    })
    expect(wrapper.get(".created-key-value").text()).toBe(
      "eruoo_one_time_raw_key",
    )
    expect(wrapper.text()).toContain("完整密钥只显示这一次")
    expect(apiKeyMocks.list).toHaveBeenCalledTimes(2)
  })

  it("keeps the created raw key visible when the list refresh confirms an expired Session", async () => {
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 401 },
      })
    apiKeyMocks.create.mockResolvedValue({
      data: { key: "eruoo_created_before_session_expired" },
      error: null,
    })
    apiKeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(ApiKeyPanel, {
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
    await wrapper.get("#api-key-name").setValue("session-race")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.get(".created-key-value").text()).toBe(
      "eruoo_created_before_session_expired",
    )
    expect(wrapper.get(".feedback-warning").text()).toContain(
      "但 Session 随后失效",
    )
    expect(wrapper.get('[role="alert"].state-card').text()).toContain(
      "Session 已失效",
    )
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    wrapper.unmount()
  })

  it("reports a partial success without losing the raw key when the list cannot refresh", async () => {
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 503 },
      })
    apiKeyMocks.create.mockResolvedValue({
      data: { key: "eruoo_created_before_refresh_failed" },
      error: null,
    })
    apiKeyMocks.getSession.mockResolvedValue({
      data: { session: { id: "session-id" } },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("refresh-race")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.get(".created-key-value").text()).toBe(
      "eruoo_created_before_refresh_failed",
    )
    expect(wrapper.get(".feedback-warning").text()).toContain(
      "但列表暂时无法刷新",
    )
    expect(wrapper.text()).toContain("API Key 列表暂时不可用")
    expect(wrapper.text()).not.toContain(
      "已创建“refresh-race”。请立即保存下面的完整密钥。",
    )

    wrapper.unmount()
  })

  it("removes the one-time raw key when the Session becomes unavailable", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    apiKeyMocks.create
      .mockResolvedValueOnce({
        data: { key: "eruoo_one_time_raw_key" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { status: 401 },
      })
    apiKeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(ApiKeyPanel, {
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
    await wrapper.get("#api-key-name").setValue("first-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.text()).toContain("eruoo_one_time_raw_key")

    await wrapper.get("#api-key-name").setValue("second-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.text()).not.toContain("eruoo_one_time_raw_key")
    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
  })

  it("offers sign-in when an API failure is confirmed by an empty Session", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    apiKeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(ApiKeyPanel, {
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
    expect(wrapper.text()).not.toContain("列表暂时不可用")
    expect(apiKeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it.each([
    {
      label: "the Session is still valid",
      sessionResult: { data: { session: { id: "session-id" } }, error: null },
    },
    {
      label: "the Session check returns an error",
      sessionResult: { data: null, error: { status: 503 } },
    },
  ])("keeps the generic retry state when $label", async ({ sessionResult }) => {
    apiKeyMocks.list.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    apiKeyMocks.getSession.mockResolvedValue(sessionResult)
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("API Key 列表暂时不可用")
    expect(wrapper.text()).not.toContain("Session 已失效")
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(apiKeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("keeps the generic retry state when the Session check rejects", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    apiKeyMocks.getSession.mockRejectedValue(new Error("session unavailable"))
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("API Key 列表暂时不可用")
    expect(wrapper.text()).not.toContain("Session 已失效")
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(apiKeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("shows only a safe hint, permissions, and a relative expiry reminder", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: {
        apiKeys: [
          {
            enabled: true,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            id: "synthetic-key-id",
            key: "hashed-value-must-not-be-rendered",
            name: "backup-script",
            permissions: { backups: ["read"] },
            start: "eruoo_safe",
          },
        ],
      },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("backup-script")
    expect(wrapper.text()).toContain("eruoo_safe••••")
    expect(wrapper.text()).toContain("backups:read")
    expect(wrapper.text()).toMatch(/[67] 天后到期/)
    expect(wrapper.text()).not.toContain("hashed-value-must-not-be-rendered")
  })

  it("revokes a confirmed API key and removes it from the list", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: {
        apiKeys: [
          {
            enabled: true,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            id: "synthetic-key-id",
            name: "backup-script",
            permissions: { backups: ["read"] },
            start: "eruoo_safe",
          },
        ],
      },
      error: null,
    })
    apiKeyMocks.delete.mockResolvedValue({
      data: { success: true },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel, { attachTo: document.body })

    await flushPromises()
    await wrapper
      .get('button[aria-label="撤销 API Key：backup-script"]')
      .trigger("click")

    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    expect(confirmButton).toBeDefined()

    confirmButton?.click()
    await flushPromises()

    expect(apiKeyMocks.delete).toHaveBeenCalledOnce()
    expect(apiKeyMocks.delete).toHaveBeenCalledWith({
      keyId: "synthetic-key-id",
    })
    expect(
      wrapper.find('button[aria-label="撤销 API Key：backup-script"]').exists(),
    ).toBe(false)
    expect(wrapper.text()).toContain("还没有 API Key。")
    expect(wrapper.text()).toContain("已撤销“backup-script”。")

    wrapper.unmount()
  })

  it("offers sign-in when revocation detects an expired Session", async () => {
    apiKeyMocks.list.mockResolvedValue({
      data: {
        apiKeys: [
          {
            enabled: true,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            id: "synthetic-key-id",
            name: "backup-script",
            permissions: { backups: ["read"] },
            start: "eruoo_safe",
          },
        ],
      },
      error: null,
    })
    apiKeyMocks.delete.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    apiKeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(ApiKeyPanel, {
      attachTo: document.body,
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
    await wrapper
      .get('button[aria-label="撤销 API Key：backup-script"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
    expect(wrapper.text()).not.toContain("backup-script")
    expect(apiKeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })
})

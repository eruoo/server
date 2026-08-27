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
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue()
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    apiKeyMocks.create.mockResolvedValue({
      data: { id: "created-key-id", key: "eruoo_one_time_raw_key" },
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
    const rawKeyInput = wrapper.get<HTMLInputElement>("#created-api-key")
    expect(rawKeyInput.element.value).toBe("eruoo_one_time_raw_key")
    expect(rawKeyInput.attributes()).toHaveProperty("readonly")
    expect(wrapper.get('label[for="created-api-key"]').text()).toBe(
      "完整密钥只显示这一次",
    )
    expect(wrapper.text()).toContain("完整密钥只显示这一次")
    expect(apiKeyMocks.list).toHaveBeenCalledTimes(2)

    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")
    await flushPromises()

    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith("eruoo_one_time_raw_key")
    expect(wrapper.get(".copy-feedback").attributes("role")).toBe("status")
    expect(wrapper.get(".copy-feedback").text()).toBe("已复制到剪贴板。")
  })

  it("announces creation without exposing the raw key before the list refresh finishes", async () => {
    let resolveListRefresh!: (value: unknown) => void
    const listRefresh = new Promise<unknown>((resolve) => {
      resolveListRefresh = resolve
    })
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockReturnValueOnce(listRefresh)
    apiKeyMocks.create.mockResolvedValue({
      data: { id: "created-key-id", key: "eruoo_live_region_secret" },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("status-cli")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    const announcement = wrapper.get(".created-key-announcement")
    expect(announcement.attributes("role")).toBe("status")
    expect(announcement.attributes("aria-live")).toBe("polite")
    expect(announcement.attributes("aria-atomic")).toBe("true")
    expect(announcement.text()).toBe(
      "API Key 已创建。完整密钥已显示，请立即保存。",
    )
    expect(announcement.text()).not.toContain("eruoo_live_region_secret")
    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_live_region_secret")
    expect(wrapper.find(".feedback").exists()).toBe(false)

    resolveListRefresh({ data: { apiKeys: [] }, error: null })
    await flushPromises()

    const visibleCreationFeedback = wrapper.get(".feedback-success")
    expect(visibleCreationFeedback.text()).toContain("已创建“status-cli”")
    expect(visibleCreationFeedback.attributes("role")).toBeUndefined()
    expect(visibleCreationFeedback.attributes("aria-live")).toBeUndefined()
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)

    wrapper.unmount()
  })

  it("keeps the raw key visible and preserves creation feedback when copying fails", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("clipboard unavailable"),
    )
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    apiKeyMocks.create.mockResolvedValue({
      data: { id: "created-key-id", key: "eruoo_copy_failure_key" },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("status-cli")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")
    await flushPromises()

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_copy_failure_key")
    expect(wrapper.get(".copy-feedback").attributes("role")).toBe("alert")
    expect(wrapper.get(".copy-feedback").text()).toContain(
      "请手动选择并复制完整密钥",
    )
    expect(
      wrapper
        .get('button[aria-label="复制完整 API Key"]')
        .attributes("aria-busy"),
    ).toBe("false")
    expect(wrapper.get(".feedback-success").text()).toContain(
      "已创建“status-cli”",
    )
  })

  it("offers manual copying when the Clipboard API is unavailable", async () => {
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as never)
    apiKeyMocks.list.mockResolvedValue({
      data: { apiKeys: [] },
      error: null,
    })
    apiKeyMocks.create.mockResolvedValue({
      data: { id: "created-key-id", key: "eruoo_no_clipboard_key" },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("status-cli")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")
    await flushPromises()

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_no_clipboard_key")
    expect(wrapper.get(".copy-feedback").attributes("role")).toBe("alert")
    expect(wrapper.get(".copy-feedback").text()).toContain(
      "请手动选择并复制完整密钥",
    )
    expect(
      wrapper
        .get('button[aria-label="复制完整 API Key"]')
        .attributes("aria-busy"),
    ).toBe("false")
  })

  it("blocks creating a replacement key while a clipboard write is pending", async () => {
    let resolveFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve
    })
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce()
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          apiKeys: [
            {
              enabled: true,
              id: "first-key-id",
              name: "first-key",
              permissions: { status: ["read"] },
              start: "eruoo_first",
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          apiKeys: [
            {
              enabled: true,
              id: "first-key-id",
              name: "first-key",
              permissions: { status: ["read"] },
              start: "eruoo_first",
            },
            {
              enabled: true,
              id: "second-key-id",
              name: "second-key",
              permissions: { status: ["read"] },
              start: "eruoo_second",
            },
          ],
        },
        error: null,
      })
    apiKeyMocks.create
      .mockResolvedValueOnce({
        data: { id: "first-key-id", key: "eruoo_first_raw_key" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: "second-key-id", key: "eruoo_second_raw_key" },
        error: null,
      })
    const wrapper = mount(ApiKeyPanel)

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("first-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")

    const pendingCopyButton = wrapper.get(
      'button[aria-label="剪贴板写入处理中，请稍候"]',
    )
    expect(pendingCopyButton.attributes("aria-busy")).toBe("true")
    expect(pendingCopyButton.attributes()).toHaveProperty("disabled")

    await wrapper.get("#api-key-name").setValue("second-key")
    const createButton = wrapper.get('button[type="submit"]')
    expect(createButton.text()).toBe("复制处理中")
    expect(createButton.attributes()).toHaveProperty("disabled")

    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(apiKeyMocks.create).toHaveBeenCalledOnce()
    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_first_raw_key")
    expect(writeText).toHaveBeenCalledOnce()

    resolveFirstWrite()
    await flushPromises()

    expect(createButton.text()).toBe("创建")
    expect(createButton.attributes()).not.toHaveProperty("disabled")

    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(apiKeyMocks.create).toHaveBeenCalledTimes(2)
    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_second_raw_key")

    const nextCopyButton = wrapper.get('button[aria-label="复制完整 API Key"]')

    await nextCopyButton.trigger("click")
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText).toHaveBeenNthCalledWith(1, "eruoo_first_raw_key")
    expect(writeText).toHaveBeenNthCalledWith(2, "eruoo_second_raw_key")
    expect(wrapper.get(".copy-feedback").text()).toBe("已复制到剪贴板。")
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
      data: {
        id: "session-race-key-id",
        key: "eruoo_created_before_session_expired",
      },
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

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_created_before_session_expired")
    expect(wrapper.get(".feedback-warning").text()).toContain(
      "但 Session 随后失效",
    )
    expect(wrapper.get(".feedback-warning").attributes("role")).toBe("alert")
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
      data: {
        id: "refresh-race-key-id",
        key: "eruoo_created_before_refresh_failed",
      },
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

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_created_before_refresh_failed")
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
        data: { id: "first-key-id", key: "eruoo_one_time_raw_key" },
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

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_one_time_raw_key")

    await wrapper.get("#api-key-name").setValue("second-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.find("#created-api-key").exists()).toBe(false)
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
    expect(wrapper.get(".feedback-success").attributes("role")).toBe("status")

    wrapper.unmount()
  })

  it("removes the matching one-time raw key and copy feedback after revocation", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          apiKeys: [
            {
              enabled: true,
              expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
              id: "created-key-id",
              name: "status-cli",
              permissions: { status: ["read"] },
              start: "eruoo_created",
            },
          ],
        },
        error: null,
      })
    apiKeyMocks.create.mockResolvedValue({
      data: { id: "created-key-id", key: "eruoo_revoked_raw_key" },
      error: null,
    })
    apiKeyMocks.delete.mockResolvedValue({
      data: { success: true },
      error: null,
    })
    const wrapper = mount(ApiKeyPanel, { attachTo: document.body })

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("status-cli")
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")
    await flushPromises()

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_revoked_raw_key")
    expect(wrapper.text()).toContain("已复制到剪贴板")

    await wrapper
      .get('button[aria-label="撤销 API Key：status-cli"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(apiKeyMocks.delete).toHaveBeenCalledWith({
      keyId: "created-key-id",
    })
    expect(wrapper.find(".created-key").exists()).toBe(false)
    expect(wrapper.find("#created-api-key").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("已复制到剪贴板")

    wrapper.unmount()
  })

  it("keeps a pending native copy locked across revocation and remount", async () => {
    let resolveFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve
    })
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(firstWrite)
      .mockResolvedValueOnce()
    apiKeyMocks.list
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          apiKeys: [
            {
              enabled: true,
              id: "first-key-id",
              name: "first-key",
              permissions: { status: ["read"] },
              start: "eruoo_first",
            },
          ],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { apiKeys: [] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          apiKeys: [
            {
              enabled: true,
              id: "second-key-id",
              name: "second-key",
              permissions: { status: ["read"] },
              start: "eruoo_second",
            },
          ],
        },
        error: null,
      })
    apiKeyMocks.create
      .mockResolvedValueOnce({
        data: { id: "first-key-id", key: "eruoo_first_raw_key" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: "second-key-id", key: "eruoo_second_raw_key" },
        error: null,
      })
    apiKeyMocks.delete.mockResolvedValue({
      data: { success: true },
      error: null,
    })
    let wrapper = mount(ApiKeyPanel, { attachTo: document.body })

    await flushPromises()
    await wrapper.get("#api-key-name").setValue("first-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()
    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")

    expect(wrapper.get('button[type="submit"]').text()).toBe("复制处理中")

    await wrapper
      .get('button[aria-label="撤销 API Key：first-key"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.find(".created-key").exists()).toBe(false)
    expect(wrapper.get('button[type="submit"]').text()).toBe("创建")
    expect(
      wrapper.get('button[type="submit"]').attributes(),
    ).not.toHaveProperty("disabled")

    wrapper.unmount()
    wrapper = mount(ApiKeyPanel, { attachTo: document.body })
    await flushPromises()

    await wrapper.get("#api-key-name").setValue("second-key")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(writeText).toHaveBeenNthCalledWith(1, "eruoo_first_raw_key")
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_second_raw_key")
    expect(
      wrapper.get('button[aria-label="等待上一次剪贴板写入完成"]').attributes(),
    ).toHaveProperty("disabled")
    expect(wrapper.get(".copy-feedback").text()).toBe(
      "上一次剪贴板写入尚未完成，请稍后再复制。",
    )
    expect(
      wrapper.get("#created-api-key").attributes("aria-describedby"),
    ).toContain("created-api-key-copy-wait")
    const blockedManualCopy = new Event("copy", { cancelable: true })
    wrapper.get("#created-api-key").element.dispatchEvent(blockedManualCopy)
    expect(blockedManualCopy.defaultPrevented).toBe(true)

    resolveFirstWrite()
    await flushPromises()

    expect(
      wrapper.get<HTMLInputElement>("#created-api-key").element.value,
    ).toBe("eruoo_second_raw_key")
    expect(wrapper.find(".copy-feedback").exists()).toBe(false)
    expect(
      wrapper.get('button[aria-label="复制完整 API Key"]').attributes(),
    ).not.toHaveProperty("disabled")
    const allowedManualCopy = new Event("copy", { cancelable: true })
    wrapper.get("#created-api-key").element.dispatchEvent(allowedManualCopy)
    expect(allowedManualCopy.defaultPrevented).toBe(false)

    await wrapper.get('button[aria-label="复制完整 API Key"]').trigger("click")
    await flushPromises()

    expect(writeText).toHaveBeenNthCalledWith(2, "eruoo_second_raw_key")
    expect(wrapper.get(".copy-feedback").text()).toBe("已复制到剪贴板。")
    expect(
      wrapper.get('button[type="submit"]').attributes(),
    ).not.toHaveProperty("disabled")

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

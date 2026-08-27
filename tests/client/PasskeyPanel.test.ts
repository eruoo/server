import PasskeyPanel from "@client/features/security/PasskeyPanel.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const passkeyMocks = vi.hoisted(() => ({
  addPasskey: vi.fn<
    (options?: { name?: string }) => Promise<{
      data: unknown
      error: unknown
    }>
  >(),
  deletePasskey:
    vi.fn<
      (input: { id: string }) => Promise<{ data: unknown; error: unknown }>
    >(),
  getSession: vi.fn<
    () => Promise<{
      data: unknown
      error: unknown
    }>
  >(),
  refetch: vi.fn<() => Promise<void>>(),
  useListPasskeys: vi.fn<() => unknown>(),
}))

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    passkey: {
      addPasskey: passkeyMocks.addPasskey,
      deletePasskey: passkeyMocks.deletePasskey,
    },
    getSession: passkeyMocks.getSession,
    useListPasskeys: passkeyMocks.useListPasskeys,
  },
}))

describe("PasskeyPanel", () => {
  beforeEach(() => {
    passkeyMocks.addPasskey.mockReset()
    passkeyMocks.deletePasskey.mockReset()
    passkeyMocks.getSession.mockReset()
    passkeyMocks.refetch.mockReset()
    passkeyMocks.useListPasskeys.mockReset()
    passkeyMocks.getSession.mockResolvedValue({
      data: { session: { id: "session-id" } },
      error: null,
    })
    passkeyMocks.useListPasskeys.mockReturnValue(
      ref({
        data: [],
        error: null,
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
  })

  it("renders the owner-safe empty state", () => {
    const wrapper = mount(PasskeyPanel)

    expect(wrapper.text()).toContain("尚未注册 Passkey")
    expect(wrapper.get("h2").text()).toBe("Passkey")
  })

  it("starts a named WebAuthn registration and refreshes the list", async () => {
    passkeyMocks.addPasskey.mockResolvedValue({ data: {}, error: null })
    passkeyMocks.refetch.mockResolvedValue(undefined)
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("input").setValue("MacBook Touch ID")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(passkeyMocks.addPasskey).toHaveBeenCalledWith({
      name: "MacBook Touch ID",
    })
    expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain("Passkey 已添加")
  })

  it("offers strong reauthentication when a sensitive action is stale", async () => {
    passkeyMocks.addPasskey.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        type: "https://auth.eruoo.me/problems/recent-authentication-required",
      },
    })
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(wrapper.text()).toContain("需要重新确认身份")
    expect(wrapper.text()).toContain("使用 Passkey")
    expect(wrapper.text()).toContain("使用 GitHub")
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("offers sign-in when a list failure is confirmed by an empty Session", async () => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [],
        error: { status: 401 },
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    passkeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(PasskeyPanel, {
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
    expect(wrapper.find("form").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("无法读取 Passkey 列表")
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()

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
  ])("keeps the generic list error when $label", async ({ sessionResult }) => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [],
        error: { message: "synthetic list detail" },
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    passkeyMocks.getSession.mockResolvedValue(sessionResult)
    const wrapper = mount(PasskeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("无法读取 Passkey 列表")
    expect(wrapper.text()).not.toContain("Session 已失效")
    expect(wrapper.text()).not.toContain("synthetic list detail")
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("keeps the generic list error when the Session check rejects", async () => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [],
        error: { message: "synthetic list detail" },
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    passkeyMocks.getSession.mockRejectedValue(new Error("probe unavailable"))
    const wrapper = mount(PasskeyPanel)

    await flushPromises()

    expect(wrapper.text()).toContain("无法读取 Passkey 列表")
    expect(wrapper.text()).not.toContain("Session 已失效")
    expect(wrapper.text()).not.toContain("synthetic list detail")
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("checks the Session again when a list retry rejects", async () => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [],
        error: { status: 503 },
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    passkeyMocks.getSession
      .mockResolvedValueOnce({
        data: { session: { id: "session-id" } },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })
    passkeyMocks.refetch.mockRejectedValue(new Error("retry failed"))
    const wrapper = mount(PasskeyPanel, {
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
    await wrapper.get(".text-button").trigger("click")
    await flushPromises()

    expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
    expect(passkeyMocks.getSession).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    wrapper.unmount()
  })

  it("offers sign-in when adding a Passkey detects an expired Session", async () => {
    passkeyMocks.addPasskey.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    passkeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(PasskeyPanel, {
      global: {
        stubs: {
          RouterLink: {
            props: ["to"],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    })

    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    wrapper.unmount()
  })

  it("offers sign-in when deleting a Passkey detects an expired Session", async () => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [
          {
            backedUp: true,
            deviceType: "multiDevice",
            id: "passkey-id",
            name: "MacBook Touch ID",
          },
        ],
        error: null,
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    passkeyMocks.deletePasskey.mockResolvedValue({
      data: null,
      error: { status: 401 },
    })
    passkeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    const wrapper = mount(PasskeyPanel, {
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

    await wrapper
      .get('button[aria-label="删除 MacBook Touch ID"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认删除"),
    )
    expect(confirmButton).toBeDefined()

    confirmButton?.click()
    await flushPromises()

    expect(passkeyMocks.deletePasskey).toHaveBeenCalledWith({
      id: "passkey-id",
    })
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    wrapper.unmount()
  })

  it("does not render raw list or operation errors", async () => {
    passkeyMocks.useListPasskeys.mockReturnValueOnce(
      ref({
        data: [],
        error: { message: "synthetic list implementation detail" },
        isPending: false,
        isRefetching: false,
        refetch: passkeyMocks.refetch,
      }),
    )
    const listWrapper = mount(PasskeyPanel)

    await flushPromises()

    expect(listWrapper.text()).toContain("无法读取 Passkey 列表")
    expect(listWrapper.text()).not.toContain("synthetic list implementation")
    listWrapper.unmount()

    passkeyMocks.addPasskey.mockResolvedValue({
      data: null,
      error: { message: "synthetic operation implementation detail" },
    })
    const operationWrapper = mount(PasskeyPanel)

    await operationWrapper.get("form").trigger("submit")
    await flushPromises()

    expect(operationWrapper.text()).toContain("Passkey 添加失败")
    expect(operationWrapper.text()).not.toContain(
      "synthetic operation implementation",
    )
    expect(passkeyMocks.getSession).toHaveBeenCalledTimes(2)
    operationWrapper.unmount()
  })
})

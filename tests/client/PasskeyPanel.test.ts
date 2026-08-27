import PasskeyPanel from "@client/features/security/PasskeyPanel.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const credentialId = "Y3JlZGVudGlhbC1pZA"

interface PasskeyListItem {
  backedUp: boolean
  credentialID: string
  deviceType: "multiDevice" | "singleDevice"
  id: string
  name: string
}

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
  function createPasskeyQuery(data: PasskeyListItem[] = []) {
    return ref({
      data,
      error: null as unknown,
      isPending: false,
      isRefetching: false,
      refetch: passkeyMocks.refetch,
    })
  }

  async function completeAutomaticPasskeyRefresh(
    query: ReturnType<typeof createPasskeyQuery>,
    data: PasskeyListItem[],
    error: unknown = null,
  ): Promise<void> {
    query.value.isRefetching = true
    await Promise.resolve()
    query.value.data = data
    query.value.error = error
    query.value.isRefetching = false
  }

  let defaultPasskeyQuery: ReturnType<typeof createPasskeyQuery>

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
    defaultPasskeyQuery = createPasskeyQuery()
    passkeyMocks.useListPasskeys.mockReturnValue(defaultPasskeyQuery)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ""
  })

  function configureDeletablePasskey() {
    const query = createPasskeyQuery([
      {
        backedUp: true,
        credentialID: credentialId,
        deviceType: "multiDevice",
        id: "passkey-id",
        name: "MacBook Touch ID",
      },
    ])
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    passkeyMocks.deletePasskey.mockImplementation(async () => {
      await completeAutomaticPasskeyRefresh(query, [])
      return {
        data: { status: true },
        error: null,
      }
    })
    passkeyMocks.refetch.mockResolvedValue(undefined)

    return query
  }

  async function confirmPasskeyDeletion(
    wrapper: ReturnType<typeof mount>,
  ): Promise<void> {
    await wrapper
      .get('button[aria-label="删除 MacBook Touch ID"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认删除"),
    )

    if (!confirmButton) {
      throw new Error("The Passkey deletion confirmation was not rendered.")
    }

    confirmButton.click()
    await flushPromises()
  }

  it("renders the owner-safe empty state", () => {
    const wrapper = mount(PasskeyPanel)

    expect(wrapper.text()).toContain("尚未注册 Passkey")
    expect(wrapper.get("h2").text()).toBe("Passkey")
  })

  it("starts a named WebAuthn registration without a second list refresh", async () => {
    passkeyMocks.addPasskey.mockImplementation(async () => {
      await completeAutomaticPasskeyRefresh(defaultPasskeyQuery, [
        {
          backedUp: true,
          credentialID: credentialId,
          deviceType: "multiDevice",
          id: "passkey-id",
          name: "MacBook Touch ID",
        },
      ])
      return { data: {}, error: null }
    })
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("input").setValue("MacBook Touch ID")
    await wrapper.get("form").trigger("submit")
    await flushPromises()

    expect(passkeyMocks.addPasskey).toHaveBeenCalledWith({
      name: "MacBook Touch ID",
    })
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("Passkey 已添加")
    expect(wrapper.text()).toContain("MacBook Touch ID")
  })

  it("does not let a manual retry overlap an in-progress registration", async () => {
    const query = createPasskeyQuery()
    query.value.error = { status: 503 }
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    let continueRegistration!: () => void
    const registrationGate = new Promise<void>((resolve) => {
      continueRegistration = resolve
    })
    passkeyMocks.addPasskey.mockImplementation(async () => {
      await registrationGate
      await completeAutomaticPasskeyRefresh(query, [
        {
          backedUp: true,
          credentialID: credentialId,
          deviceType: "multiDevice",
          id: "passkey-id",
          name: "MacBook Touch ID",
        },
      ])
      return { data: {}, error: null }
    })
    const wrapper = mount(PasskeyPanel)

    await flushPromises()
    await wrapper.get("input").setValue("MacBook Touch ID")
    await wrapper.get("form").trigger("submit")

    const retryButton = wrapper.get("button.text-button")
    expect(retryButton.attributes()).toHaveProperty("disabled")
    await retryButton.trigger("click")
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()

    continueRegistration()
    await flushPromises()

    expect(wrapper.text()).toContain("MacBook Touch ID")
    expect(wrapper.find("button.text-button").exists()).toBe(false)

    wrapper.unmount()
  })

  it("falls back to one explicit refresh when the automatic refresh never starts", async () => {
    vi.useFakeTimers()
    const query = createPasskeyQuery()
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    passkeyMocks.addPasskey.mockResolvedValue({ data: {}, error: null })
    passkeyMocks.refetch.mockImplementation(async () => {
      query.value.data = [
        {
          backedUp: true,
          credentialID: credentialId,
          deviceType: "multiDevice",
          id: "passkey-id",
          name: "Fallback Passkey",
        },
      ]
    })
    const wrapper = mount(PasskeyPanel)

    try {
      await wrapper.get("form").trigger("submit")
      await flushPromises()

      expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty(
        "disabled",
      )

      await vi.advanceTimersByTimeAsync(1_000)
      await flushPromises()

      expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
      expect(wrapper.text()).toContain("Fallback Passkey")
      expect(
        wrapper.get('button[type="submit"]').attributes(),
      ).not.toHaveProperty("disabled")
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it("cancels an automatic refresh barrier when the panel unmounts", async () => {
    const query = createPasskeyQuery()
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    let finishRegistration!: (result: { data: unknown; error: unknown }) => void
    passkeyMocks.addPasskey.mockReturnValue(
      new Promise((resolve) => {
        finishRegistration = resolve
      }),
    )
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("form").trigger("submit")
    wrapper.unmount()
    finishRegistration({ data: {}, error: null })
    await flushPromises()

    query.value.isRefetching = true
    query.value.error = { status: 503 }
    query.value.isRefetching = false
    await flushPromises()

    expect(passkeyMocks.getSession).not.toHaveBeenCalled()
  })

  it("does not classify a fallback refresh after the panel unmounts", async () => {
    vi.useFakeTimers()
    const query = createPasskeyQuery()
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    passkeyMocks.addPasskey.mockResolvedValue({ data: {}, error: null })
    let finishFallbackRefresh!: () => void
    passkeyMocks.refetch.mockReturnValue(
      new Promise((resolve) => {
        finishFallbackRefresh = resolve
      }),
    )
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("form").trigger("submit")
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()

    expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
    wrapper.unmount()
    query.value.error = { status: 503 }
    finishFallbackRefresh()
    await flushPromises()

    expect(passkeyMocks.getSession).not.toHaveBeenCalled()
  })

  it("does not probe the Session when a mutation fails after unmount", async () => {
    let finishRegistration!: (result: { data: unknown; error: unknown }) => void
    passkeyMocks.addPasskey.mockReturnValue(
      new Promise((resolve) => {
        finishRegistration = resolve
      }),
    )
    const wrapper = mount(PasskeyPanel)

    await wrapper.get("form").trigger("submit")
    wrapper.unmount()
    finishRegistration({ data: null, error: { status: 503 } })
    await flushPromises()

    expect(passkeyMocks.getSession).not.toHaveBeenCalled()
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

  it("checks the Session again when a list retry resolves with an error", async () => {
    const query = ref({
      data: [],
      error: { status: 503 } as unknown,
      isPending: false,
      isRefetching: false,
      refetch: passkeyMocks.refetch,
    })
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    passkeyMocks.getSession
      .mockResolvedValueOnce({
        data: { session: { id: "session-id" } },
        error: null,
      })
      .mockResolvedValue({ data: null, error: null })
    passkeyMocks.refetch.mockImplementation(async () => {
      query.value.error = { status: 401 }
    })
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
    expect(passkeyMocks.getSession.mock.calls.length).toBeGreaterThanOrEqual(2)
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
            credentialID: credentialId,
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
    const signalUnknownCredential = vi
      .fn<(options: UnknownCredentialOptions) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential })
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
    expect(signalUnknownCredential).not.toHaveBeenCalled()
    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()
    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    wrapper.unmount()
  })

  it("requests local credential cleanup after server deletion", async () => {
    const query = configureDeletablePasskey()
    passkeyMocks.deletePasskey.mockImplementation(async () => {
      await completeAutomaticPasskeyRefresh(query, [])
      return { data: { status: true }, error: null }
    })
    const signalUnknownCredential = vi
      .fn<(options: UnknownCredentialOptions) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential })
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(passkeyMocks.deletePasskey).toHaveBeenCalledExactlyOnceWith({
      id: "passkey-id",
    })
    expect(signalUnknownCredential).toHaveBeenCalledExactlyOnceWith({
      credentialId,
      rpId: window.location.hostname,
    })
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()
    expect(wrapper.get(".feedback").text()).toContain(
      "已请求当前设备的凭据管理器隐藏或删除对应凭据",
    )
    expect(wrapper.get(".feedback").text()).toContain("仍可能需要手动处理")
    expect(wrapper.text()).toContain("尚未注册 Passkey")

    wrapper.unmount()
  })

  it("keeps mutations locked until the automatic delete refresh settles", async () => {
    const query = createPasskeyQuery([
      {
        backedUp: true,
        credentialID: credentialId,
        deviceType: "multiDevice",
        id: "passkey-id",
        name: "MacBook Touch ID",
      },
      {
        backedUp: true,
        credentialID: "cGhvbmUtY3JlZGVudGlhbA",
        deviceType: "multiDevice",
        id: "phone-passkey-id",
        name: "Phone Passkey",
      },
    ])
    passkeyMocks.useListPasskeys.mockReturnValueOnce(query)
    passkeyMocks.deletePasskey.mockResolvedValue({
      data: { status: true },
      error: null,
    })
    passkeyMocks.addPasskey.mockResolvedValue({ data: {}, error: null })
    vi.stubGlobal("PublicKeyCredential", {})
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await wrapper
      .get('button[aria-label="删除 MacBook Touch ID"]')
      .trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认删除"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(passkeyMocks.deletePasskey).toHaveBeenCalledOnce()
    expect(wrapper.get('button[type="submit"]').attributes()).toHaveProperty(
      "disabled",
    )
    expect(
      wrapper.get('button[aria-label="删除 Phone Passkey"]').attributes(),
    ).toHaveProperty("disabled")

    await wrapper.get("form").trigger("submit")
    expect(passkeyMocks.addPasskey).not.toHaveBeenCalled()

    query.value.isRefetching = true
    query.value.data = query.value.data.filter(({ id }) => id !== "passkey-id")
    query.value.isRefetching = false
    await flushPromises()

    expect(wrapper.text()).not.toContain("MacBook Touch ID")
    expect(
      wrapper.get('button[aria-label="删除 Phone Passkey"]').attributes(),
    ).not.toHaveProperty("disabled")

    wrapper.unmount()
  })

  it("explains manual cleanup when the browser lacks the Signal API", async () => {
    configureDeletablePasskey()
    vi.stubGlobal("PublicKeyCredential", {})
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(passkeyMocks.deletePasskey).toHaveBeenCalledOnce()
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()
    expect(wrapper.get(".feedback").text()).toContain(
      "当前浏览器不支持同步清理设备中的凭据",
    )
    expect(wrapper.get(".feedback").text()).toContain(
      "请在凭据管理器中手动移除",
    )
    expect(wrapper.get(".feedback").classes()).toContain("feedback-warning")
    expect(wrapper.get(".feedback").attributes("role")).toBe("status")

    wrapper.unmount()
  })

  it("keeps server deletion successful when credential signaling fails", async () => {
    configureDeletablePasskey()
    const signalUnknownCredential = vi
      .fn<(options: UnknownCredentialOptions) => Promise<void>>()
      .mockRejectedValue(new Error("synthetic credential provider detail"))
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential })
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(passkeyMocks.deletePasskey).toHaveBeenCalledOnce()
    expect(signalUnknownCredential).toHaveBeenCalledOnce()
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()
    expect(wrapper.get(".feedback").text()).toContain("Passkey 已删除")
    expect(wrapper.get(".feedback").text()).toContain(
      "请在凭据管理器中手动移除",
    )
    expect(wrapper.get(".feedback").text()).toContain(
      "未能同步清理当前设备中的凭据",
    )
    expect(wrapper.get(".feedback").classes()).toContain("feedback-warning")
    expect(wrapper.text()).not.toContain("synthetic credential provider detail")

    wrapper.unmount()
  })

  it("keeps cleanup guidance while a successful retry clears the list error", async () => {
    const query = configureDeletablePasskey()
    passkeyMocks.deletePasskey.mockImplementation(async () => {
      await completeAutomaticPasskeyRefresh(query, query.value.data, {
        message: "synthetic refresh detail",
        status: 503,
      })
      return { data: { status: true }, error: null }
    })
    passkeyMocks.refetch.mockImplementation(async () => {
      query.value.data = []
      query.value.error = null
    })
    vi.stubGlobal("PublicKeyCredential", {})
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(wrapper.get(".feedback").classes()).toContain("feedback-warning")
    expect(wrapper.get(".feedback").text()).toContain(
      "请在凭据管理器中手动移除",
    )
    expect(wrapper.text()).toContain("无法读取 Passkey 列表")
    expect(wrapper.text()).not.toContain("synthetic refresh detail")
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()

    await wrapper.get(".text-button").trigger("click")
    await flushPromises()

    expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
    expect(wrapper.get(".feedback").text()).toContain(
      "请在凭据管理器中手动移除",
    )
    expect(wrapper.text()).not.toContain("无法读取 Passkey 列表")
    expect(wrapper.text()).toContain("尚未注册 Passkey")

    wrapper.unmount()
  })

  it("keeps cleanup guidance without duplicating an expired Session message", async () => {
    const query = configureDeletablePasskey()
    passkeyMocks.deletePasskey.mockImplementation(async () => {
      await completeAutomaticPasskeyRefresh(query, query.value.data, {
        status: 503,
      })
      return { data: { status: true }, error: null }
    })
    passkeyMocks.refetch.mockImplementation(async () => {
      query.value.error = { status: 401 }
    })
    vi.stubGlobal("PublicKeyCredential", {})
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

    await confirmPasskeyDeletion(wrapper)
    passkeyMocks.getSession.mockResolvedValue({ data: null, error: null })
    await wrapper.get(".text-button").trigger("click")
    await flushPromises()

    expect(wrapper.get(".feedback").text()).toContain(
      "请在凭据管理器中手动移除",
    )
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
    expect(wrapper.text().match(/Session 已失效/g)).toHaveLength(1)
    expect(wrapper.text()).not.toContain("Session 随后失效")

    wrapper.unmount()
  })

  it("treats an exact not-found response with a valid Session as idempotent deletion", async () => {
    const query = configureDeletablePasskey()
    passkeyMocks.deletePasskey.mockResolvedValue({
      data: null,
      error: { code: "PASSKEY_NOT_FOUND", status: 404 },
    })
    passkeyMocks.refetch.mockImplementation(async () => {
      query.value.data = []
      query.value.error = null
    })
    const signalUnknownCredential = vi
      .fn<(options: UnknownCredentialOptions) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential })
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()
    expect(signalUnknownCredential).toHaveBeenCalledExactlyOnceWith({
      credentialId,
      rpId: window.location.hostname,
    })
    expect(passkeyMocks.refetch).toHaveBeenCalledOnce()
    expect(wrapper.get(".feedback").text()).toContain("Passkey 已不在服务端")
    expect(wrapper.text()).toContain("尚未注册 Passkey")

    wrapper.unmount()
  })

  it("does not signal for non-not-found deletion errors", async () => {
    configureDeletablePasskey()
    passkeyMocks.deletePasskey.mockResolvedValue({
      data: null,
      error: { code: "SYNTHETIC_FAILURE", status: 500 },
    })
    const signalUnknownCredential = vi
      .fn<(options: UnknownCredentialOptions) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal("PublicKeyCredential", { signalUnknownCredential })
    const wrapper = mount(PasskeyPanel, { attachTo: document.body })

    await confirmPasskeyDeletion(wrapper)

    expect(passkeyMocks.getSession).toHaveBeenCalledOnce()
    expect(signalUnknownCredential).not.toHaveBeenCalled()
    expect(passkeyMocks.refetch).not.toHaveBeenCalled()
    expect(wrapper.get(".feedback").text()).toContain("Passkey 删除失败")

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

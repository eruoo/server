import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import {
  getAiAuthorization,
  listAiConnections,
  listAiProviders,
  pollAiAuthorization,
  refreshAiModels,
  startAiAuthorization,
} from "../../src/client/features/ai/ai-connections"
import AiConnectionsPanel from "../../src/client/features/ai/AiConnectionsPanel.vue"
import { ApiError } from "../../src/client/lib/http"

vi.mock("../../src/client/features/ai/ai-connections", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/client/features/ai/ai-connections")
  >("../../src/client/features/ai/ai-connections")
  return {
    ...actual,
    cancelAiAuthorization: vi.fn<typeof actual.cancelAiAuthorization>(),
    createAiConnection: vi.fn<typeof actual.createAiConnection>(),
    deleteAiConnection: vi.fn<typeof actual.deleteAiConnection>(),
    disconnectAiConnection: vi.fn<typeof actual.disconnectAiConnection>(),
    getAiAuthorization: vi.fn<typeof actual.getAiAuthorization>(),
    listAiConnections: vi.fn<typeof actual.listAiConnections>(),
    listAiProviders: vi.fn<typeof actual.listAiProviders>(),
    pollAiAuthorization: vi.fn<typeof actual.pollAiAuthorization>(),
    refreshAiModels: vi.fn<typeof actual.refreshAiModels>(),
    renameAiConnection: vi.fn<typeof actual.renameAiConnection>(),
    setAiConnectionEnabled: vi.fn<typeof actual.setAiConnectionEnabled>(),
    startAiAuthorization: vi.fn<typeof actual.startAiAuthorization>(),
  }
})

const baseConnection = {
  authorizationStatus: "connected",
  createdAt: 1,
  credentialExpiresAt: Date.now() + 3_600_000,
  enabled: true,
  id: "11111111-1111-1111-1111-111111111111",
  models: [
    {
      capabilities: {
        reasoningEfforts: ["low", "high"],
        supportedInApi: true,
        visibility: "list",
      },
      discoveredAt: 1_700_000_000_000,
      displayName: "GPT Test",
      id: "gpt-test",
    },
  ],
  name: "Main",
  providerType: "openai-codex",
  slug: "codex-main",
  updatedAt: 1,
  upstreamAccount: "ac…main",
}

function mountPanel(session = createSessionController()) {
  return mount(AiConnectionsPanel, {
    global: {
      provide: { [sessionKey as symbol]: session },
      stubs: {
        ConfirmAction: {
          emits: ["confirm"],
          props: ["actionLabel"],
          template: `<button class="confirm" @click="$emit('confirm')">{{ actionLabel }}</button>`,
        },
      },
    },
  })
}

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
  sessionStorage.clear()
})

const startedAuthorization = {
  authorizationId: "22222222-2222-2222-2222-222222222222",
  expiresAt: Date.now() + 900_000,
  intervalMs: 5_000,
  userCode: "ABCD-EFGH",
  verificationUrl: "https://auth.openai.com/codex/device",
}

function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

it("renders the model catalog with protocol, capabilities and discovery time", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([
    {
      authorizationKind: "device-code",
      deviceVerificationUrl: "https://auth.openai.com/codex/device",
      issuer: "https://auth.openai.com",
      providerType: "openai-codex",
      responsesStyle: "responses-subset",
    },
  ])

  const wrapper = mountPanel()
  await flushPromises()

  const catalog = wrapper.get('[data-testid="ai-model-catalog"]')
  expect(catalog.text()).toContain("gpt-test")
  expect(catalog.text()).toContain("GPT Test")
  expect(catalog.text()).toContain("协议 Responses（子集）")
  expect(catalog.text()).toContain("推理强度 low/high · API 可用 · 可见性 list")
  expect(catalog.text()).toContain(new Date(1_700_000_000_000).toLocaleString())
})

it("distinguishes the authorized, reauth and unauthorized states", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([
    baseConnection,
    {
      ...baseConnection,
      authorizationStatus: "reauthentication_required",
      id: "33333333-3333-3333-3333-333333333333",
      slug: "codex-backup",
    },
    {
      ...baseConnection,
      authorizationStatus: "never_authorized",
      id: "44444444-4444-4444-4444-444444444444",
      slug: "codex-new",
    },
  ] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])

  const wrapper = mountPanel()
  await flushPromises()

  const states = wrapper
    .findAll('[data-testid="ai-connection-state"]')
    .map((node) => node.text())
  expect(states[0]).toContain("连接已授权")
  expect(states[1]).toContain("需要重新授权")
  expect(states[2]).toContain("尚未授权")
  // The upstream account is masked, never shown as the raw identifier.
  expect(states[0]).toContain("账号 ac…main")
  expect(wrapper.text()).not.toContain("account-main")
})

it("surfaces a model discovery failure while keeping the last snapshot", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(refreshAiModels).mockRejectedValue(
    new Error("上游返回协议错误，未更新目录"),
  )

  const wrapper = mountPanel()
  await flushPromises()
  const refresh = wrapper
    .findAll("button")
    .find((button) => button.text().includes("刷新模型"))
  await refresh?.trigger("click")
  await flushPromises()

  expect(wrapper.get('[data-testid="ai-discovery-failure"]').text()).toContain(
    "模型发现失败",
  )
  expect(wrapper.get('[data-testid="ai-model-catalog"]').text()).toContain(
    "gpt-test",
  )
})

it("polls on the server schedule and stops when the session completes", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue({
    authorizationId: "22222222-2222-2222-2222-222222222222",
    expiresAt: Date.now() + 900_000,
    intervalMs: 5_000,
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
  })
  vi.mocked(pollAiAuthorization)
    .mockResolvedValueOnce({
      nextPollAt: Date.now() + 4_000,
      status: "pending",
    })
    .mockResolvedValue({ status: "completed" })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()

  // No manual click: the first poll fires on the upstream interval.
  expect(vi.mocked(pollAiAuthorization)).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)
  await flushPromises()
  expect(wrapper.text()).toContain("尚未完成")

  // The pending result scheduled the next poll at nextPollAt.
  await vi.advanceTimersByTimeAsync(4_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(2)
  await flushPromises()
  expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(false)

  // A completed session stops polling entirely.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(2)
})

it("resumes a pending authorization after the page is reopened", async () => {
  vi.useFakeTimers()
  sessionStorage.setItem(
    "ai-pending-authorization",
    JSON.stringify({
      authorizationId: "22222222-2222-2222-2222-222222222222",
      connectionId: baseConnection.id,
    }),
  )
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(getAiAuthorization).mockResolvedValue({
    expiresAt: Date.now() + 600_000,
    nextPollAt: Date.now() + 3_000,
    status: "pending",
  })
  vi.mocked(pollAiAuthorization).mockResolvedValue({ status: "pending" })

  const wrapper = mountPanel()
  await flushPromises()

  expect(vi.mocked(getAiAuthorization)).toHaveBeenCalledWith(
    "22222222-2222-2222-2222-222222222222",
    expect.anything(),
  )
  expect(wrapper.text()).toContain("已恢复进行中的授权会话")
  await vi.advanceTimersByTimeAsync(3_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)
})

it("does not resume an authorization the server no longer holds pending", async () => {
  vi.useFakeTimers()
  sessionStorage.setItem(
    "ai-pending-authorization",
    JSON.stringify({
      authorizationId: "22222222-2222-2222-2222-222222222222",
      connectionId: baseConnection.id,
    }),
  )
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(getAiAuthorization).mockResolvedValue({ status: "expired" })

  const wrapper = mountPanel()
  await flushPromises()

  expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(false)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(vi.mocked(pollAiAuthorization)).not.toHaveBeenCalled()
  expect(sessionStorage.getItem("ai-pending-authorization")).toBeNull()
})

it("keeps polling when the timer fires while the list is still refreshing", async () => {
  vi.useFakeTimers()
  // The list refresh stays in flight well past the poll interval, which is the
  // window where a poll gated on the shared busy flag would be dropped.
  const slowList = defer<never[]>()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockResolvedValue({ status: "pending" })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()

  // A manual refresh holds the list busy across the next scheduled poll.
  vi.mocked(listAiConnections).mockReturnValue(slowList.promise as never)
  const refresh = wrapper
    .findAll("button")
    .find((button) => button.text().includes("刷新列表"))
  void refresh?.trigger("click")
  await flushPromises()

  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)

  // And the loop keeps re-arming after that poll.
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(2)
  slowList.resolve([] as never)
})

it("refreshes the catalog after a completed authorization and reports a refresh failure", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockResolvedValue({ status: "completed" })
  vi.mocked(refreshAiModels).mockRejectedValue(new Error("上游暂不可用"))

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()

  // §5.1 step 8: the client issues its own catalog refresh after completion.
  expect(vi.mocked(refreshAiModels)).toHaveBeenCalledWith(baseConnection.id)
  // §5.3: the failure is shown as a discovery failure, not as an auth failure.
  expect(wrapper.get('[data-testid="ai-discovery-failure"]').text()).toContain(
    "模型发现失败",
  )
  const message = wrapper.get('[data-testid="ai-authorization-message"]').text()
  expect(message).toContain("授权完成")
  expect(message).toContain("模型目录刷新失败")
})

it("reads the persisted session back when the poll request fails", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockRejectedValue(
    new Error("请求超时，请重试"),
  )
  vi.mocked(getAiAuthorization).mockResolvedValue({ status: "pending" })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()

  // §6.1: a failed poll reads the persisted state instead of replaying.
  expect(vi.mocked(getAiAuthorization)).toHaveBeenCalledWith(
    "22222222-2222-2222-2222-222222222222",
    expect.anything(),
  )
  expect(wrapper.text()).toContain("尚未完成")
})

it("stops retrying once a poll and its read-back are terminally rejected", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockRejectedValue(
    new ApiError(404, "not-found", "授权会话不存在"),
  )
  vi.mocked(getAiAuthorization).mockRejectedValue(
    new ApiError(404, "not-found", "授权会话不存在"),
  )

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()

  expect(wrapper.text()).toContain("授权会话已不可用")
  expect(sessionStorage.getItem("ai-pending-authorization")).toBeNull()
  const calls = vi.mocked(pollAiAuthorization).mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(vi.mocked(pollAiAuthorization).mock.calls.length).toBe(calls)
})

it("clears the session when the server reports a terminal poll status", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockResolvedValue({ status: "cancelled" })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()

  expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(false)
  expect(sessionStorage.getItem("ai-pending-authorization")).toBeNull()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)
})

it("keeps polling a replacement authorization while the previous poll is in flight", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  const firstPoll = defer<Awaited<ReturnType<typeof pollAiAuthorization>>>()
  vi.mocked(startAiAuthorization)
    .mockResolvedValueOnce(startedAuthorization)
    .mockResolvedValueOnce({
      ...startedAuthorization,
      authorizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    })
  vi.mocked(pollAiAuthorization)
    .mockReturnValueOnce(firstPoll.promise)
    .mockResolvedValue({ status: "pending" })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = () =>
    wrapper
      .findAll("button")
      .find((button) => button.text().includes("开始设备授权"))
  await authorize()?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)

  // The owner replaces the round while the first poll never came back.
  await authorize()?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  firstPoll.resolve({ status: "pending" })
  await flushPromises()
  await vi.advanceTimersByTimeAsync(30_000)

  // The replaced round's late request must not have killed the new loop: B
  // polls once on its schedule and keeps re-arming from there.
  const polled = vi
    .mocked(pollAiAuthorization)
    .mock.calls.map((call) => call[0])
  expect(
    polled.filter((id) => id === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").length,
  ).toBeGreaterThanOrEqual(2)
  wrapper.unmount()
})

it("ignores a stale authorization restore once another authorization started", async () => {
  vi.useFakeTimers()
  sessionStorage.setItem(
    "ai-pending-authorization",
    JSON.stringify({
      authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      connectionId: baseConnection.id,
    }),
  )
  const restored = defer<Awaited<ReturnType<typeof getAiAuthorization>>>()
  vi.mocked(getAiAuthorization).mockReturnValue(restored.promise)
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue({
    ...startedAuthorization,
    authorizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userCode: "NEW-CODE",
  })

  const wrapper = mountPanel()
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  const code = () =>
    (
      wrapper.get('input[aria-label="设备授权代码"]')
        .element as HTMLInputElement
    ).value
  expect(code()).toBe("NEW-CODE")

  // The page-reopen read lands after the replacement round started: it must
  // not overwrite the code, the state, the storage or the new timer.
  restored.resolve({
    expiresAt: Date.now() + 600_000,
    nextPollAt: Date.now() + 5_000,
    status: "pending",
  })
  await flushPromises()

  expect(code()).toBe("NEW-CODE")
  expect(wrapper.text()).not.toContain("已恢复进行中的授权会话")
  expect(
    JSON.parse(sessionStorage.getItem("ai-pending-authorization") ?? "null")
      ?.authorizationId,
  ).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
  await vi.advanceTimersByTimeAsync(5_000)
  expect(
    vi.mocked(pollAiAuthorization).mock.calls.map((call) => call[0]),
  ).toEqual(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
  wrapper.unmount()
})

it("ends an unrecoverable round after re-verification created a new session", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockRejectedValue(
    new ApiError(
      403,
      "https://auth.eruoo.me/problems/recent-authentication-required",
      "Reauthenticate",
    ),
  )
  // The re-verification created a new owner session; the round is bound to
  // the old one, so the persisted read is refused — no verification can
  // recover it.
  vi.mocked(getAiAuthorization).mockRejectedValue(
    new ApiError(
      403,
      "https://auth.eruoo.me/problems/permission-denied",
      "Session changed",
    ),
  )
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      session: { id: "old-session", userId: "owner" },
      user: { id: "owner", name: "Owner" },
    }),
  )
  const session = createSessionController()
  await session.refresh(true)
  const wrapper = mountPanel(session)
  await flushPromises()
  try {
    const authorize = wrapper
      .findAll("button")
      .find((button) => button.text().includes("开始设备授权"))
    await authorize?.trigger("click")
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(wrapper.text()).toContain("重新验证")

    fetchMock.mockResolvedValue(
      Response.json({
        session: { id: "new-session", userId: "owner" },
        user: { id: "owner", name: "Owner" },
      }),
    )
    await session.refresh(true)
    await flushPromises()

    // The refused read ends the round: no stale device-authorization view,
    // no useless re-verification prompt, no resumed polling, and a fresh
    // round may begin.
    expect(vi.mocked(getAiAuthorization)).toHaveBeenCalledWith(
      startedAuthorization.authorizationId,
      expect.anything(),
    )
    expect(sessionStorage.getItem("ai-pending-authorization")).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(
      false,
    )
    expect(wrapper.text()).not.toContain("重新验证")
    expect(wrapper.text()).toContain("请重新开始")
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("开始设备授权")),
    ).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it("keeps the round for a later retry when the persisted read fails transiently", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockRejectedValue(
    new ApiError(
      403,
      "https://auth.eruoo.me/problems/recent-authentication-required",
      "Reauthenticate",
    ),
  )
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      session: { id: "old-session", userId: "owner" },
      user: { id: "owner", name: "Owner" },
    }),
  )
  const session = createSessionController()
  await session.refresh(true)
  const wrapper = mountPanel(session)
  await flushPromises()
  try {
    const authorize = wrapper
      .findAll("button")
      .find((button) => button.text().includes("开始设备授权"))
    await authorize?.trigger("click")
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(wrapper.text()).toContain("重新验证")

    // The first re-verification cannot read the persisted state (a transient
    // network failure, not a refusal): the round survives, so a later
    // verification can still resume it.
    vi.mocked(getAiAuthorization).mockRejectedValue(new Error("network down"))
    fetchMock.mockResolvedValue(
      Response.json({
        session: { id: "session-two", userId: "owner" },
        user: { id: "owner", name: "Owner" },
      }),
    )
    await session.refresh(true)
    await flushPromises()
    expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(true)
    expect(sessionStorage.getItem("ai-pending-authorization")).not.toBeNull()

    vi.mocked(getAiAuthorization).mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      nextPollAt: Date.now() + 5_000,
      status: "pending",
    })
    fetchMock.mockResolvedValue(
      Response.json({
        session: { id: "session-three", userId: "owner" },
        user: { id: "owner", name: "Owner" },
      }),
    )
    await session.refresh(true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(2)
  } finally {
    wrapper.unmount()
  }
})

it("surfaces a recent-authentication refusal instead of masking it with a read-back", async () => {
  vi.useFakeTimers()
  vi.mocked(listAiConnections).mockResolvedValue([baseConnection] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])
  vi.mocked(startAiAuthorization).mockResolvedValue(startedAuthorization)
  vi.mocked(pollAiAuthorization).mockRejectedValue(
    new ApiError(
      403,
      "https://auth.eruoo.me/problems/recent-authentication-required",
      "Reauthenticate",
    ),
  )
  // A read-back would report the session as pending; it must not be used to
  // hide the refusal behind an endless poll.
  vi.mocked(getAiAuthorization).mockResolvedValue({
    expiresAt: Date.now() + 600_000,
    nextPollAt: Date.now() + 5_000,
    status: "pending",
  })

  const session = createSessionController()
  const wrapper = mountPanel(session)
  await flushPromises()
  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  await authorize?.trigger("click")
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  await flushPromises()

  expect(wrapper.text()).toContain("重新验证")
  expect(wrapper.text()).not.toContain("尚未完成")
  expect(vi.mocked(getAiAuthorization)).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(1)

  // Once the owner re-verified, the round continues from the persisted state.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      session: { id: "session", userId: "owner" },
      user: { id: "owner", name: "Owner" },
    }),
  )
  await session.refresh(true)
  await flushPromises()
  expect(vi.mocked(getAiAuthorization)).toHaveBeenCalledWith(
    "22222222-2222-2222-2222-222222222222",
    expect.anything(),
  )
  await vi.advanceTimersByTimeAsync(5_000)
  expect(vi.mocked(pollAiAuthorization)).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})

it("keeps the create form disabled until the panel's own load settles", async () => {
  const connections = defer<never[]>()
  vi.mocked(listAiConnections).mockReturnValue(connections.promise as never)
  vi.mocked(listAiProviders).mockResolvedValue([])

  const wrapper = mountPanel()
  const slugInput = () => wrapper.get('input[placeholder="codex-main"]')
  // The form must not be editable in the panel's first render: a field that is
  // enabled while the panel's own read is still on its way would be disabled
  // again by that read and drop what was typed meanwhile.
  expect(slugInput().attributes("disabled")).toBeDefined()

  connections.resolve([] as never)
  await flushPromises()
  expect(slugInput().attributes("disabled")).toBeUndefined()
})

it("labels a disabled connection and does not claim models when the catalog is empty", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([
    { ...baseConnection, enabled: false, models: [] },
  ] as never)
  vi.mocked(listAiProviders).mockResolvedValue([])

  const wrapper = mountPanel()
  await flushPromises()

  expect(wrapper.get('[data-testid="ai-connection-state"]').text()).toContain(
    "已停用",
  )
  expect(wrapper.find('[data-testid="ai-model-catalog"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="ai-catalog-empty"]').text()).toContain(
    "不声明模型可用",
  )
})

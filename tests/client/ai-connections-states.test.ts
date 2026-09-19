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
  upstreamAccountId: "account-main",
}

function mountPanel() {
  return mount(AiConnectionsPanel, {
    global: {
      provide: { [sessionKey as symbol]: createSessionController() },
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
  vi.useRealTimers()
  sessionStorage.clear()
})

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

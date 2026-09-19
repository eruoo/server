import { flushPromises, mount } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import {
  disconnectAiConnection,
  listAiConnections,
  pollAiAuthorization,
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
    getAiAuthorization: vi.fn<typeof actual.getAiAuthorization>(),
    listAiProviders: vi.fn<typeof actual.listAiProviders>(),
    createAiConnection: vi.fn<typeof actual.createAiConnection>(),
    deleteAiConnection: vi.fn<typeof actual.deleteAiConnection>(),
    disconnectAiConnection: vi.fn<typeof actual.disconnectAiConnection>(),
    listAiConnections: vi.fn<typeof actual.listAiConnections>(),
    pollAiAuthorization: vi.fn<typeof actual.pollAiAuthorization>(),
    refreshAiModels: vi.fn<typeof actual.refreshAiModels>(),
    renameAiConnection: vi.fn<typeof actual.renameAiConnection>(),
    setAiConnectionEnabled: vi.fn<typeof actual.setAiConnectionEnabled>(),
    startAiAuthorization: vi.fn<typeof actual.startAiAuthorization>(),
  }
})

const connection = {
  authorizationStatus: "connected",
  createdAt: 1,
  credentialExpiresAt: Date.now() + 3_600_000,
  enabled: true,
  id: "11111111-1111-1111-1111-111111111111",
  models: [
    { capabilities: null, discoveredAt: 1, displayName: null, id: "gpt-test" },
  ],
  name: "Main",
  providerType: "openai-codex",
  slug: "codex-main",
  updatedAt: 1,
  upstreamAccount: "ac…main",
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

it("shows the connection snapshot and drives the authorization flow", async () => {
  vi.mocked(listAiConnections)
    .mockResolvedValueOnce([connection] as never)
    .mockResolvedValueOnce([
      { ...connection, authorizationStatus: "connected" },
    ] as never)
  vi.mocked(startAiAuthorization).mockResolvedValue({
    authorizationId: "22222222-2222-2222-2222-222222222222",
    expiresAt: Date.now() + 900_000,
    intervalMs: 5_000,
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
  })
  vi.mocked(pollAiAuthorization).mockResolvedValue({ status: "completed" })

  const wrapper = mountPanel()
  await flushPromises()
  expect(wrapper.text()).toContain("codex-main")
  expect(wrapper.text()).toContain("gpt-test")
  expect(wrapper.text()).toContain("已启用")

  const authorize = wrapper
    .findAll("button")
    .find((button) => button.text().includes("开始设备授权"))
  expect(authorize).toBeDefined()
  await authorize?.trigger("click")
  await flushPromises()
  expect(
    (
      wrapper.get('input[aria-label="设备授权代码"]')
        .element as HTMLInputElement
    ).value,
  ).toBe("ABCD-EFGH")

  const poll = wrapper
    .findAll("button")
    .find((button) => button.text().includes("检查授权状态"))
  await poll?.trigger("click")
  await flushPromises()
  // A completed poll forgets the code and reloads the list.
  expect(wrapper.find('[data-testid="ai-authorization"]').exists()).toBe(false)
  expect(vi.mocked(listAiConnections).mock.calls.length).toBeGreaterThan(1)
})

it("disconnects a connection through the confirmation action", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  vi.mocked(disconnectAiConnection).mockResolvedValue(undefined)

  const wrapper = mountPanel()
  await flushPromises()
  const disconnect = wrapper
    .findAll(".confirm")
    .find((button) => button.text().includes("断开"))
  await disconnect?.trigger("click")
  await flushPromises()
  expect(disconnectAiConnection).toHaveBeenCalledWith(connection.id)
})

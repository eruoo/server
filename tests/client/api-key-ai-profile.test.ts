import { flushPromises, mount } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import { listAiConnections } from "../../src/client/features/ai/ai-connections"
import {
  createApiKeyForProfile,
  listApiKeysForProfile,
  updateAiKeyModelGrants,
} from "../../src/client/features/security/api-keys"
import ApiKeyPanel from "../../src/client/features/security/ApiKeyPanel.vue"

vi.mock("../../src/client/features/security/api-keys", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/client/features/security/api-keys")
  >("../../src/client/features/security/api-keys")
  return {
    createApiKeyForProfile: vi.fn<typeof actual.createApiKeyForProfile>(),
    listApiKeysForProfile: vi.fn<typeof actual.listApiKeysForProfile>(),
    removeApiKeyFromProfile: vi.fn<typeof actual.removeApiKeyFromProfile>(),
    renameApiKeyInProfile: vi.fn<typeof actual.renameApiKeyInProfile>(),
    updateAiKeyModelGrants: vi.fn<typeof actual.updateAiKeyModelGrants>(),
  }
})
vi.mock("../../src/client/features/ai/ai-connections", () => ({
  listAiConnections: vi.fn<typeof listAiConnections>(),
}))

const connection = {
  authorizationStatus: "connected",
  createdAt: 1,
  credentialExpiresAt: null,
  enabled: true,
  id: "11111111-1111-1111-1111-111111111111",
  models: [
    { capabilities: null, discoveredAt: 1, displayName: null, id: "gpt-test" },
  ],
  name: "Main",
  providerType: "openai-codex",
  slug: "codex-main",
  updatedAt: 1,
  upstreamAccountId: null,
}

function mountPanel() {
  return mount(ApiKeyPanel, {
    global: {
      provide: { [sessionKey as symbol]: createSessionController() },
      stubs: {
        ConfirmAction: {
          emits: ["confirm"],
          template: `<button class="revoke" @click="$emit('confirm')">Revoke</button>`,
        },
      },
    },
  })
}

it("creates an ai key with the selected model grants", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  vi.mocked(listApiKeysForProfile).mockResolvedValue([] as never)
  vi.mocked(createApiKeyForProfile).mockResolvedValue({
    expiresAt: null,
    id: "ai-key-id",
    key: "eruoo_ai_secret",
    name: "ai probe",
    start: "eruoo_",
  } as never)

  const wrapper = mountPanel()
  await flushPromises()

  // The default profile is read first; switching names the ai profile.
  expect(listApiKeysForProfile).toHaveBeenCalledWith(
    expect.anything(),
    "default",
  )
  const aiTab = wrapper
    .findAll("button")
    .find((button) => button.text().includes("AI 密钥"))
  await aiTab?.trigger("click")
  await flushPromises()
  expect(listApiKeysForProfile).toHaveBeenLastCalledWith(
    expect.anything(),
    "ai",
  )

  // The grant picker lists the catalog's external model IDs and gates create.
  const createButton = wrapper
    .findAll("button")
    .find((button) => button.text().includes("创建密钥"))
  expect(createButton?.attributes("disabled")).toBeDefined()
  const checkbox = wrapper.get(
    '[data-testid="ai-model-grants"] input[type="checkbox"]',
  )
  await checkbox.setValue(true)
  await wrapper.get('[data-testid="key-name"]').setValue("ai probe")
  await flushPromises()
  const enabledCreate = wrapper
    .findAll("button")
    .find((button) => button.text().includes("创建密钥"))
  expect(enabledCreate?.attributes("disabled")).toBeUndefined()
  // jsdom does not submit a form from a button click; trigger the form.
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(createApiKeyForProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      configId: "ai",
      modelIds: ["codex-main/gpt-test"],
    }),
  )
  expect(
    (wrapper.find('[aria-label="完整密钥"]').element as HTMLInputElement).value,
  ).toBe("eruoo_ai_secret")
})

it("saves a replacement model grant for an existing ai key", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  const key = {
    configId: "ai",
    expiresAt: null,
    id: "ai-key-id",
    key: "hashed",
    name: "ai probe",
    permissions: {
      ai: ["invoke", "models:read"],
      "ai-model:11111111-1111-1111-1111-111111111111": ["gpt-test"],
    },
    start: "eruoo_",
  }
  vi.mocked(listApiKeysForProfile).mockResolvedValue([key] as never)
  vi.mocked(updateAiKeyModelGrants).mockResolvedValue(undefined)

  const wrapper = mountPanel()
  await flushPromises()
  const aiTab = wrapper
    .findAll("button")
    .find((button) => button.text().includes("AI 密钥"))
  await aiTab?.trigger("click")
  await flushPromises()

  // The stored grant is shown, edited, and replaced wholesale.
  const grantInput = wrapper.get('[data-testid="key-grant"]')
  expect((grantInput.element as HTMLInputElement).value).toBe(
    "codex-main/gpt-test",
  )
  await grantInput.setValue("codex-main/gpt-test, codex-main/other-model")
  const save = wrapper
    .findAll("button")
    .find((button) => button.text().includes("保存模型许可"))
  await save?.trigger("click")
  await flushPromises()
  expect(updateAiKeyModelGrants).toHaveBeenCalledWith("ai-key-id", [
    "codex-main/gpt-test",
    "codex-main/other-model",
  ])
})

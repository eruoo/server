import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

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

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
  sessionStorage.clear()
})

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, reject, resolve }
}

function aiTab(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().includes("AI 密钥"))
}

it("keeps the create form disabled until the panel's own reads settle", async () => {
  const catalog = defer<never[]>()
  const keys = defer<never[]>()
  vi.mocked(listAiConnections).mockReturnValue(catalog.promise as never)
  vi.mocked(listApiKeysForProfile).mockReturnValue(keys.promise as never)

  const wrapper = mountPanel()
  await flushPromises()
  const nameInput = () => wrapper.get('[data-testid="key-name"]')
  expect(nameInput().attributes("disabled")).toBeDefined()

  // A form that is enabled while a read is still on its way would be disabled
  // again by that read and silently drop what the owner typed meanwhile.
  catalog.resolve([] as never)
  await flushPromises()
  expect(nameInput().attributes("disabled")).toBeDefined()

  keys.resolve([] as never)
  await flushPromises()
  expect(nameInput().attributes("disabled")).toBeUndefined()
})

it("isolates the list when the profile changes and a new read fails", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  const aiKeys = defer<never[]>()
  vi.mocked(listApiKeysForProfile).mockImplementation(
    async (_signal, profile) =>
      profile === "ai"
        ? aiKeys.promise
        : ([
            {
              configId: "default",
              id: "status-key",
              name: "STATUS_ONLY",
              permissions: { status: ["read"] },
            },
          ] as never),
  )

  const wrapper = mountPanel()
  await flushPromises()
  const listedNames = () =>
    wrapper
      .findAll("li input")
      .map((node) => (node.element as HTMLInputElement).value)
  expect(listedNames()).toContain("STATUS_ONLY")

  await aiTab(wrapper)?.trigger("click")
  await flushPromises()
  // The previous profile's rows are dropped before the new read settles, so no
  // row action can reach them with the new configId.
  expect(listedNames()).not.toContain("STATUS_ONLY")
  expect(wrapper.findAll("li")).toHaveLength(0)
  expect(listApiKeysForProfile).toHaveBeenLastCalledWith(
    expect.anything(),
    "ai",
  )

  aiKeys.reject(new Error("unavailable"))
  await flushPromises()
  expect(listedNames()).not.toContain("STATUS_ONLY")
  expect(wrapper.findAll("li")).toHaveLength(0)
  expect(wrapper.text()).toContain("列表未加载")
})

it("does not interleave a second profile switch while one is loading", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  const aiKeys = defer<never[]>()
  vi.mocked(listApiKeysForProfile).mockImplementation(
    async (_signal, profile) =>
      profile === "ai" ? aiKeys.promise : ([] as never),
  )

  const wrapper = mountPanel()
  await flushPromises()
  const statusTab = () =>
    wrapper
      .findAll("button")
      .find((button) => button.text().includes("状态密钥"))
  await aiTab(wrapper)?.trigger("click")
  await flushPromises()

  // The switch owns the panel until it settles, so a second one cannot start
  // and leave the displayed profile and the issued read disagreeing.
  expect(statusTab()?.attributes("disabled")).toBeDefined()
  await statusTab()?.trigger("click")
  await flushPromises()
  expect(listApiKeysForProfile).toHaveBeenLastCalledWith(
    expect.anything(),
    "ai",
  )

  aiKeys.resolve([] as never)
  await flushPromises()
  expect(statusTab()?.attributes("disabled")).toBeUndefined()
})

it("keeps the grant draft verbatim and parses it when saving", async () => {
  vi.mocked(listAiConnections).mockResolvedValue([connection] as never)
  const key = {
    configId: "ai",
    expiresAt: null,
    id: "ai-key-id",
    key: "hashed",
    name: "ai probe",
    permissions: {
      "ai-model:11111111-1111-1111-1111-111111111111": ["gpt-test"],
    },
    start: "eruoo_",
  }
  vi.mocked(listApiKeysForProfile).mockResolvedValue([key] as never)
  vi.mocked(updateAiKeyModelGrants).mockResolvedValue(undefined)

  const wrapper = mountPanel()
  await flushPromises()
  await aiTab(wrapper)?.trigger("click")
  await flushPromises()

  const grant = wrapper.get('[data-testid="key-grant"]')
  await grant.setValue("codex-main/gpt-test,")
  // A typed separator is part of the draft, not something to normalise away.
  expect((grant.element as HTMLInputElement).value).toBe("codex-main/gpt-test,")
  await grant.setValue("codex-main/gpt-test, codex-main/other-model")
  const save = () =>
    wrapper
      .findAll("button")
      .find((button) => button.text().includes("保存模型许可"))
  await save()?.trigger("click")
  await flushPromises()
  expect(updateAiKeyModelGrants).toHaveBeenCalledWith("ai-key-id", "ai probe", [
    "codex-main/gpt-test",
    "codex-main/other-model",
  ])

  // Clearing the field and saving still means: revoke every model grant.
  await grant.setValue("")
  await save()?.trigger("click")
  await flushPromises()
  expect(updateAiKeyModelGrants).toHaveBeenLastCalledWith(
    "ai-key-id",
    "ai probe",
    [],
  )
})

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
  // The update contract always carries the key name alongside the grants.
  expect(updateAiKeyModelGrants).toHaveBeenCalledWith("ai-key-id", "ai probe", [
    "codex-main/gpt-test",
    "codex-main/other-model",
  ])
})

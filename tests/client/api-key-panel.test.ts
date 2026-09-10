import { mount, flushPromises } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import {
  createApiKey,
  listApiKeys,
  removeApiKey,
} from "../../src/client/features/security/api-keys"
import ApiKeyPanel from "../../src/client/features/security/ApiKeyPanel.vue"
vi.mock("../../src/client/features/security/api-keys", () => ({
  listApiKeys: vi.fn<typeof listApiKeys>(),
  createApiKey: vi.fn<typeof createApiKey>(),
  renameApiKey:
    vi.fn<
      typeof import("../../src/client/features/security/api-keys").renameApiKey
    >(),
  removeApiKey: vi.fn<typeof removeApiKey>(),
}))
it("successful revoke clears the just-created key display", async () => {
  const key = {
    id: "created-key-id",
    name: "probe",
    key: "eruoo_probe_secret",
    start: "eruoo_",
    expiresAt: new Date(Date.now() + 86400000),
  }
  vi.mocked(listApiKeys)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([key] as never)
    .mockResolvedValueOnce([])
  vi.mocked(createApiKey).mockResolvedValue(key as never)
  vi.mocked(removeApiKey).mockResolvedValue(undefined)
  const wrapper = mount(ApiKeyPanel, {
    global: {
      provide: {
        [sessionKey as symbol]: createSessionController(),
      },
      stubs: {
        ConfirmAction: {
          emits: ["confirm"],
          template: `<button class="revoke" @click="$emit('confirm')">Revoke</button>`,
        },
      },
    },
  })
  await flushPromises()
  await wrapper.find("form").trigger("submit")
  await flushPromises()
  expect(
    (wrapper.find('[aria-label="完整密钥"]').element as HTMLInputElement).value,
  ).toBe(key.key)
  await wrapper.find(".revoke").trigger("click")
  await flushPromises()
  expect(removeApiKey).toHaveBeenCalledWith(key.id)
  expect(wrapper.findAll("li")).toHaveLength(0)
  expect(wrapper.find('[aria-label="完整密钥"]').exists()).toBe(false)
  wrapper.unmount()
})

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import OAuthPanel from "../../src/client/features/security/OAuthPanel.vue"

afterEach(() => vi.restoreAllMocks())

const clients = [
  {
    activeRefreshTokenCount: 1,
    authorized: true,
    clientId: "eruoo-desktop",
    consentCount: 0,
    enabled: true,
    lastAuthorizedAt: Date.now(),
    name: "eruoo Desktop",
    offlineAccess: true,
    platform: "desktop",
    resources: ["https://auth.eruoo.me/api"],
    scopes: ["api:read", "offline_access"],
    supportsOfflineAccess: true,
  },
  {
    activeRefreshTokenCount: 0,
    authorized: false,
    clientId: "future-client",
    consentCount: 0,
    enabled: false,
    lastAuthorizedAt: null,
    name: "Future Client",
    offlineAccess: false,
    platform: "web",
    resources: [],
    scopes: [],
    supportsOfflineAccess: false,
  },
]

it("renders authorization state and revokes through the delete endpoint", async () => {
  const deleteCalls: Array<{ method: string; url: string }> = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "DELETE") {
      deleteCalls.push({ method: "DELETE", url: String(input) })
      return Response.json({ clientId: "eruoo-desktop" })
    }
    return Response.json(clients)
  })
  const wrapper = mount(OAuthPanel, {
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
  const items = wrapper.findAll("li")
  expect(items).toHaveLength(2)
  expect(items[0]!.text()).toContain("eruoo Desktop")
  expect(items[0]!.text()).toContain("已授权")
  expect(items[0]!.text()).toContain("权限：api:read、offline_access")
  expect(items[1]!.text()).toContain("Future Client")
  expect(items[1]!.text()).toContain("尚未开放")
  expect(wrapper.findAll(".revoke")).toHaveLength(1)
  await wrapper.find(".revoke").trigger("click")
  await flushPromises()
  expect(deleteCalls).toEqual([
    { method: "DELETE", url: "/api/oauth/authorizations/eruoo-desktop" },
  ])
  wrapper.unmount()
})

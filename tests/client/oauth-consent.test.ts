import { mount, flushPromises } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import {
  createSessionController,
  sessionKey,
} from "../../src/client/composables/session"
import { authClient } from "../../src/client/lib/auth-client"
import OAuthConsentView from "../../src/client/views/OAuthConsentView.vue"
vi.mock("vue-router", () => ({
  useRoute: () => ({
    query: { client_id: "eruoo-desktop", scope: "openid offline_access" },
  }),
}))
vi.mock("../../src/client/lib/auth-client", () => ({
  authClient: {
    oauth2: { consent: vi.fn<typeof authClient.oauth2.consent>() },
  },
}))
it.each(["success", "invalid signature"])(
  "ignores a late %s consent response after leaving the page",
  async (outcome) => {
    vi.mocked(authClient.oauth2.consent).mockClear()
    const query = new URLSearchParams({
      client_id: "eruoo-desktop",
      scope: "openid offline_access",
      exp: String(Math.floor(Date.now() / 1000) + 100),
      ba_iat: String(Date.now()),
      sig: "probe",
    })
    for (const name of ["ba_param", "exp", "ba_iat", "client_id", "scope"])
      query.append("ba_param", name)
    window.history.replaceState(null, "", "/oauth/consent?" + query.toString())
    let finish!: (value: unknown) => void
    vi.mocked(authClient.oauth2.consent).mockImplementation(
      () => new Promise((resolve) => (finish = resolve)) as never,
    )
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined)
    const wrapper = mount(OAuthConsentView, {
      global: {
        provide: { [sessionKey as symbol]: createSessionController() },
        stubs: { SessionBoundary: { template: "<div><slot /></div>" } },
      },
    })
    await wrapper.find("button").trigger("click")
    expect(authClient.oauth2.consent).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    window.history.replaceState(null, "", "/account")
    finish(
      outcome === "invalid signature"
        ? { data: null, error: { code: "invalid_signature" } }
        : {
            data: {
              redirect: true,
              url: "http://127.0.0.1:12345/callback?code=probe",
            },
            error: null,
          },
    )
    await flushPromises()
    expect(assign).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe("/account")
    assign.mockRestore()
  },
)

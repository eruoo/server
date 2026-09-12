import { mount, flushPromises } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

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
    signOut: vi.fn<typeof authClient.signOut>(),
  },
}))
afterEach(() => vi.restoreAllMocks())
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

it.each([
  { outcome: "pending", response: "success" },
  { outcome: "success", response: "success" },
  { outcome: "failure", response: "success" },
  { outcome: "success", response: "invalid_signature" },
] as const)(
  "ignores a late $response consent response after $outcome sign-out without leaving the route",
  async ({ outcome, response }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        user: { id: "owner", name: "Owner", email: "owner@example.invalid" },
        session: { id: "session", userId: "owner" },
      }),
    )
    const session = createSessionController()
    await session.refresh()
    const query = new URLSearchParams({
      client_id: "eruoo-desktop",
      scope: "openid offline_access",
      exp: String(Math.floor(Date.now() / 1000) + 100),
      ba_iat: String(Date.now()),
      sig: "probe",
    })
    for (const name of ["ba_param", "exp", "ba_iat", "client_id", "scope"])
      query.append("ba_param", name)
    const location = "/oauth/consent?" + query.toString()
    window.history.replaceState(null, "", location)
    let finishConsent!: (value: unknown) => void
    let finishSignOut!: (value: unknown) => void
    vi.mocked(authClient.oauth2.consent).mockImplementation(
      () => new Promise((resolve) => (finishConsent = resolve)) as never,
    )
    vi.mocked(authClient.signOut).mockImplementation(
      () => new Promise((resolve) => (finishSignOut = resolve)) as never,
    )
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined)
    const wrapper = mount(OAuthConsentView, {
      global: { provide: { [sessionKey as symbol]: session } },
    })
    let signOut: Promise<void> | undefined
    try {
      await wrapper.find("button").trigger("click")
      expect(finishConsent).toBeTypeOf("function")
      signOut = session.signOut()
      if (outcome !== "pending") {
        finishSignOut(
          outcome === "success"
            ? { data: { success: true }, error: null }
            : { data: null, error: { message: "Unavailable" } },
        )
        await signOut
      }
      await flushPromises()
      expect(session.status.value).toBe(
        outcome === "pending"
          ? "signing-out"
          : outcome === "success"
            ? "anonymous"
            : "unavailable",
      )
      finishConsent(
        response === "invalid_signature"
          ? { data: null, error: { code: "invalid_signature" } }
          : {
              data: {
                redirect: true,
                url: "http://127.0.0.1:12345/callback?code=late",
              },
              error: null,
            },
      )
      await flushPromises()
      expect(assign).not.toHaveBeenCalled()
      expect(window.location.pathname + window.location.search).toBe(location)
    } finally {
      wrapper.unmount()
      finishSignOut({ data: { success: true }, error: null })
      await signOut
    }
  },
)

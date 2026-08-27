import RecentAuthenticationNotice from "@client/features/auth/RecentAuthenticationNotice.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
  passkey: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
  social:
    vi.fn<
      (input: {
        callbackURL: string
        errorCallbackURL: string
        provider: "github"
      }) => Promise<{ data: unknown; error: unknown }>
    >(),
}))

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    signIn: {
      passkey: authMocks.passkey,
      social: authMocks.social,
    },
  },
}))

describe("RecentAuthenticationNotice", () => {
  beforeEach(() => {
    authMocks.passkey.mockReset()
    authMocks.social.mockReset()
  })

  it("stays out of the accessibility tree until reauthentication is needed", () => {
    const wrapper = mount(RecentAuthenticationNotice, {
      props: { visible: false },
    })

    expect(wrapper.find("section").exists()).toBe(false)
  })

  it("emits verified after successful Passkey authentication", async () => {
    authMocks.passkey.mockResolvedValue({ data: {}, error: null })
    const wrapper = mount(RecentAuthenticationNotice, {
      props: { visible: true },
    })

    const passkeyButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Passkey"))

    expect(passkeyButton).toBeDefined()
    await passkeyButton?.trigger("click")
    await flushPromises()

    expect(authMocks.passkey).toHaveBeenCalledOnce()
    expect(wrapper.emitted("verified")).toEqual([[]])
  })

  it("keeps GitHub reauthentication success and failure on the current page", async () => {
    window.history.replaceState({}, "", "/?tab=security&error=stale")
    authMocks.social.mockResolvedValue({ data: {}, error: null })
    const wrapper = mount(RecentAuthenticationNotice, {
      props: { visible: true },
    })

    const githubButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("GitHub"))

    expect(githubButton).toBeDefined()
    await githubButton?.trigger("click")
    await flushPromises()

    expect(authMocks.social).toHaveBeenCalledWith({
      callbackURL: "/?tab=security&reauthentication=github",
      errorCallbackURL: "/?tab=security&reauthentication=github",
      provider: "github",
    })

    wrapper.unmount()
    window.history.replaceState({}, "", "/")
  })
})

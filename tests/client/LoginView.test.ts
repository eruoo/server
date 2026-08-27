import LoginView from "@client/views/LoginView.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

const authMocks = vi.hoisted(() => ({
  passkeySignIn: vi.fn<() => Promise<{ data: unknown; error: unknown }>>(),
  socialSignIn:
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
      passkey: authMocks.passkeySignIn,
      social: authMocks.socialSignIn,
    },
  },
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ component: LoginView, path: "/login" }],
  })
}

function signedLoginPath(
  options: {
    expirationSeconds?: number
    includeError?: boolean
    issuedAtMilliseconds?: number
  } = {},
) {
  const issuedAtMilliseconds = options.issuedAtMilliseconds ?? Date.now()
  const expirationSeconds =
    options.expirationSeconds ?? Math.floor(issuedAtMilliseconds / 1_000) + 600
  const params = new URLSearchParams({
    ba_iat: String(issuedAtMilliseconds),
    client_id: "eruoo-desktop",
    exp: String(expirationSeconds),
    state: "original-state",
  })

  for (const parameterName of [
    "ba_iat",
    "ba_param",
    "client_id",
    "exp",
    "state",
  ]) {
    params.append("ba_param", parameterName)
  }
  params.set("sig", "synthetic-signature")

  if (options.includeError) {
    params.set("error", "access_denied")
    params.set("error_description", "synthetic-detail")
  }

  return `/login?${params}`
}

function findButtonByName(
  wrapper: ReturnType<typeof mount>,
  accessibleName: string,
) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().trim() === accessibleName)
}

const mockedPasskeySignIn = authMocks.passkeySignIn
const mockedSocialSignIn = authMocks.socialSignIn

describe("LoginView", () => {
  beforeEach(() => {
    mockedPasskeySignIn.mockResolvedValue({ data: null, error: null })
    mockedSocialSignIn.mockResolvedValue({ data: null, error: null })
  })

  it("explains an owner-only rejection without exposing upstream details", async () => {
    const router = createTestRouter()
    await router.push(
      "/login?error=owner_not_allowed&error_description=private-upstream-detail",
    )
    const wrapper = mount(LoginView, {
      global: { plugins: [router] },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "当前 GitHub 账号不是此服务允许的 owner，请改用已配置的 owner 账号。",
    )
    expect(wrapper.text()).not.toContain("private-upstream-detail")
    expect(router.currentRoute.value.fullPath).toBe("/login")

    wrapper.unmount()
  })

  it("removes only upstream error parameters while keeping the visible prompt", async () => {
    const router = createTestRouter()
    await router.push(signedLoginPath({ includeError: true }))
    const wrapper = mount(LoginView, {
      global: { plugins: [router] },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "GitHub 登录未完成，请重试。",
    )
    expect(wrapper.text()).not.toContain("synthetic-detail")
    expect(router.currentRoute.value.query["client_id"]).toBe("eruoo-desktop")
    expect(router.currentRoute.value.query["state"]).toBe("original-state")
    expect(router.currentRoute.value.query["sig"]).toBe("synthetic-signature")
    expect(router.currentRoute.value.query["error"]).toBeUndefined()
    expect(router.currentRoute.value.query["error_description"]).toBeUndefined()

    wrapper.unmount()
  })

  it("preserves the current signed continuation in the GitHub error callback", async () => {
    const router = createTestRouter()
    await router.push(signedLoginPath())
    const wrapper = mount(LoginView, {
      global: { plugins: [router] },
    })

    await findButtonByName(wrapper, "使用 GitHub")?.trigger("click")
    await flushPromises()

    expect(mockedSocialSignIn).toHaveBeenCalledOnce()
    const input = mockedSocialSignIn.mock.calls[0]?.[0]
    expect(input?.callbackURL).toBe("/")
    expect(input?.errorCallbackURL).toBe(router.currentRoute.value.fullPath)
    expect(input?.provider).toBe("github")

    wrapper.unmount()
  })

  it("clears an expired continuation before starting GitHub login", async () => {
    const now = Date.UTC(2026, 7, 24, 12)
    const expirationSeconds = Math.floor(now / 1_000) + 60
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)
    const router = createTestRouter()
    await router.push(
      signedLoginPath({ expirationSeconds, issuedAtMilliseconds: now }),
    )
    const wrapper = mount(LoginView, {
      global: { plugins: [router] },
    })

    nowSpy.mockReturnValue(expirationSeconds * 1_000 + 1)
    await findButtonByName(wrapper, "使用 GitHub")?.trigger("click")
    await flushPromises()

    expect(mockedSocialSignIn).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe("/login")
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "请返回调用应用重新发起授权",
    )

    wrapper.unmount()
  })

  it.each([
    {
      buttonName: "使用 GitHub",
      configureFailure() {
        mockedSocialSignIn.mockResolvedValueOnce({
          data: null,
          error: { error: "invalid_signature" },
        })
      },
      label: "GitHub",
    },
    {
      buttonName: "使用 Passkey",
      configureFailure() {
        mockedPasskeySignIn.mockResolvedValueOnce({
          data: null,
          error: { error: "invalid_signature" },
        })
      },
      label: "Passkey",
    },
  ])(
    "breaks the signed-query retry trap after a forged $label continuation fails",
    async ({ buttonName, configureFailure }) => {
      const router = createTestRouter()
      await router.push(signedLoginPath())
      const wrapper = mount(LoginView, {
        global: { plugins: [router] },
      })
      configureFailure()

      await findButtonByName(wrapper, buttonName)?.trigger("click")
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe("/login")
      expect(wrapper.get('[role="alert"]').text()).toContain(
        "请返回调用应用重新发起授权",
      )

      wrapper.unmount()
    },
  )
})

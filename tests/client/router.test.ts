import App from "@client/App.vue"
import { createAppRouter } from "@client/router"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, shallowRef } from "vue"

type SessionReader = () => Promise<{
  data: { session: unknown } | null
  error: unknown
}>

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn<SessionReader>(),
}))

function createSessionRefetch() {
  return vi.fn<() => Promise<void>>(async () => {})
}

const sessionState = shallowRef({
  data: null as { user: { name: string } } | null,
  error: null as unknown,
  isPending: true,
  isRefetching: false,
  refetch: createSessionRefetch(),
})

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    getSession: authMocks.getSession,
    signIn: {
      passkey: vi.fn<() => Promise<unknown>>(),
      social: vi.fn<() => Promise<unknown>>(),
    },
    signOut: vi.fn<() => Promise<unknown>>(),
    useSession: () => sessionState,
  },
}))

vi.mock("@client/features/security/BackupStatusNotice.vue", () => ({
  default: {
    name: "BackupStatusNotice",
    template: '<div data-testid="backup-status-notice-stub" />',
  },
}))

vi.mock("@client/features/security/AuthorizedApplicationsPanel.vue", () => ({
  default: {
    name: "AuthorizedApplicationsPanel",
    template:
      '<h1 id="authorized-applications-title" data-route-heading tabindex="-1">已授权应用</h1>',
  },
}))

vi.mock(
  "@client/features/security/audit-events-service",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@client/features/security/audit-events-service")
      >()

    return {
      ...original,
      auditEventsService: {
        list: async () => ({ events: [], nextCursor: null }),
      },
    }
  },
)

describe("app router accessibility", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset()
    sessionState.value = {
      data: null,
      error: null,
      isPending: true,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    window.history.replaceState({}, "", "/")
  })

  it("renders a Session boundary without protected content while verification is pending", async () => {
    const router = createAppRouter()
    const wrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          ApiKeyPanel: true,
          PasskeyPanel: true,
        },
      },
    })

    try {
      await router.isReady()
      await flushPromises()

      expect(wrapper.find("#workspace-title").exists()).toBe(false)
      expect(wrapper.text()).toContain("正在验证 Session")
      expect(authMocks.getSession).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it("settles an internal tab navigation without starting another Session request", async () => {
    sessionState.value = {
      data: { user: { name: "Synthetic Owner" } },
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }

    const router = createAppRouter()
    const wrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: {
          ApiKeyPanel: true,
          PasskeyPanel: true,
        },
      },
    })
    await router.isReady()

    const navigation = router.push("/security/authorized-apps")

    try {
      await flushPromises()

      expect(router.currentRoute.value.name).toBe("authorized-apps")
      expect(wrapper.get("#authorized-applications-title").text()).toBe(
        "已授权应用",
      )
      expect(authMocks.getSession).not.toHaveBeenCalled()
    } finally {
      await navigation
      wrapper.unmount()
    }
  })

  it("redirects only after Session state definitively becomes unauthenticated", async () => {
    window.history.replaceState({}, "", "/security/authorized-apps")
    const router = createAppRouter()
    const wrapper = mount(App, {
      global: { plugins: [router] },
    })
    await router.isReady()

    expect(router.currentRoute.value.name).toBe("authorized-apps")

    sessionState.value = {
      data: null,
      error: { status: 503 },
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    await flushPromises()
    expect(router.currentRoute.value.name).toBe("authorized-apps")

    sessionState.value = {
      data: null,
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("login")
    wrapper.unmount()
  })

  it("leaves the login view after a pending Session becomes authenticated", async () => {
    window.history.replaceState({}, "", "/login")
    const router = createAppRouter()
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          ApiKeyPanel: true,
          PasskeyPanel: true,
        },
      },
    })
    await router.isReady()

    expect(router.currentRoute.value.name).toBe("login")

    sessionState.value = {
      data: { user: { name: "Synthetic Owner" } },
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("home")
    wrapper.unmount()
  })

  it("does not bounce a deliberate sign-out navigation back to the home view", async () => {
    sessionState.value = {
      data: { user: { name: "Synthetic Owner" } },
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    const router = createAppRouter()
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          ApiKeyPanel: true,
          PasskeyPanel: true,
        },
      },
    })
    await router.isReady()

    await router.replace("/login")
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("login")
    wrapper.unmount()
  })

  it("does not bounce sign-out when a stale failed Session starts refreshing", async () => {
    const authenticatedData = { user: { name: "Synthetic Owner" } }
    sessionState.value = {
      data: authenticatedData,
      error: { status: 503 },
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    const router = createAppRouter()
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          ApiKeyPanel: true,
          PasskeyPanel: true,
        },
      },
    })
    await router.isReady()

    await router.replace("/login")

    sessionState.value = {
      data: authenticatedData,
      error: null,
      isPending: false,
      isRefetching: true,
      refetch: createSessionRefetch(),
    }
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("login")

    sessionState.value = {
      data: null,
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }
    await flushPromises()

    expect(router.currentRoute.value.name).toBe("login")
    wrapper.unmount()
  })

  it("restores scroll positions and focuses the destination heading", async () => {
    window.history.replaceState({}, "", "/security/audit-log")
    sessionState.value = {
      data: { user: { name: "Synthetic Owner" } },
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: createSessionRefetch(),
    }

    const router = createAppRouter()
    const wrapper = mount(App, {
      attachTo: document.body,
      global: { plugins: [router] },
    })

    await router.isReady()
    await flushPromises()

    const auditHeading = wrapper.get("#audit-title")
    expect(document.activeElement).toBe(auditHeading.element)

    await router.push("/missing-management-page")
    await flushPromises()
    await nextTick()

    expect(router.currentRoute.value.name).toBe("not-found")
    const notFoundHeading = wrapper.get("#not-found-title")
    expect(notFoundHeading.text()).toBe("页面不存在")
    expect(document.activeElement).toBe(notFoundHeading.element)

    const scrollBehavior = router.options.scrollBehavior
    expect(scrollBehavior).toBeDefined()

    const savedPosition = { left: 12, top: 34 }
    expect(
      await scrollBehavior?.(
        router.currentRoute.value,
        router.currentRoute.value,
        savedPosition,
      ),
    ).toEqual(savedPosition)
    expect(
      await scrollBehavior?.(
        router.currentRoute.value,
        router.currentRoute.value,
        null,
      ),
    ).toEqual({ top: 0 })

    wrapper.unmount()
  })
})

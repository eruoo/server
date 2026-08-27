import HomeView from "@client/views/HomeView.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, shallowRef } from "vue"

const sessionRefetch = vi.fn<() => Promise<void>>()

const sessionState = shallowRef<{
  data: { user: { name: string } } | null
  error: unknown | null
  isPending: boolean
  isRefetching: boolean
  refetch: typeof sessionRefetch
}>({
  data: null,
  error: null,
  isPending: true,
  isRefetching: false,
  refetch: sessionRefetch,
})

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    useSession: () => sessionState,
  },
}))

const featureStubs = {
  ApiKeyPanel: {
    template: '<div data-testid="api-key-panel"></div>',
  },
  AppShell: {
    template: "<div><slot /></div>",
  },
  PasskeyPanel: {
    template: '<div data-testid="passkey-panel"></div>',
  },
  RouterLink: {
    props: ["to"],
    template: '<a :href="to"><slot /></a>',
  },
}

describe("HomeView", () => {
  beforeEach(() => {
    sessionRefetch.mockReset()
    sessionState.value = {
      data: null,
      error: null,
      isPending: true,
      isRefetching: false,
      refetch: sessionRefetch,
    }
  })

  it("mounts credential management only while the Session is valid", async () => {
    const wrapper = mount(HomeView, {
      global: { stubs: featureStubs },
    })

    expect(wrapper.find('[data-testid="passkey-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="api-key-panel"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain("管理功能已暂停")

    sessionState.value = {
      data: null,
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: sessionRefetch,
    }
    await nextTick()

    expect(wrapper.find('[data-testid="passkey-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="api-key-panel"]').exists()).toBe(false)
    expect(wrapper.text()).toContain("管理功能已暂停")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")

    sessionState.value = {
      data: { user: { name: "Synthetic Owner" } },
      error: null,
      isPending: false,
      isRefetching: false,
      refetch: sessionRefetch,
    }
    await nextTick()

    expect(wrapper.find('[data-testid="passkey-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="api-key-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain("已验证 · Synthetic Owner")
    expect(wrapper.text()).not.toContain("管理功能已暂停")
  })

  it("offers a retry instead of sign-in when Session verification fails", async () => {
    sessionState.value = {
      data: null,
      error: { status: 503 },
      isPending: false,
      isRefetching: false,
      refetch: sessionRefetch,
    }
    sessionRefetch.mockImplementation(async () => {
      sessionState.value = {
        data: { user: { name: "Recovered Owner" } },
        error: null,
        isPending: false,
        isRefetching: false,
        refetch: sessionRefetch,
      }
    })
    const wrapper = mount(HomeView, {
      global: { stubs: featureStubs },
    })

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain("暂时无法验证 Session")
    expect(alert.get("button").text()).toBe("重试")
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain("重新登录")

    await alert.get("button").trigger("click")
    await flushPromises()

    expect(sessionRefetch).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain("已验证 · Recovered Owner")
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="passkey-panel"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it("blocks credential management when a failed refetch preserves stale Session data", () => {
    sessionState.value = {
      data: { user: { name: "Cached Owner" } },
      error: { status: 503 },
      isPending: false,
      isRefetching: false,
      refetch: sessionRefetch,
    }
    const wrapper = mount(HomeView, {
      global: { stubs: featureStubs },
    })

    expect(wrapper.text()).toContain("暂时无法验证 Session")
    expect(wrapper.text()).not.toContain("已验证 · Cached Owner")
    expect(wrapper.find('[data-testid="passkey-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="api-key-panel"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)

    wrapper.unmount()
  })
})

import App from "@client/App.vue"
import { createAppRouter } from "@client/router"
import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"

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
  it("protects the authorized applications route with the existing guard", async () => {
    const unauthenticatedRouter = createAppRouter({
      getSession: async () => ({ data: null }),
    })

    await unauthenticatedRouter.push("/security/authorized-apps")
    expect(unauthenticatedRouter.currentRoute.value.name).toBe("login")

    const authenticatedRouter = createAppRouter({
      getSession: async () => ({ data: { session: {} } }),
    })

    await authenticatedRouter.push("/security/authorized-apps")
    expect(authenticatedRouter.currentRoute.value.name).toBe("authorized-apps")
  })

  it.each([
    {
      getSession: async () => ({ data: null, error: { status: 503 } }),
      label: "the Session endpoint returns a service failure",
    },
    {
      getSession: async () => {
        throw new Error("synthetic network failure")
      },
      label: "the Session request rejects",
    },
  ])(
    "preserves a protected route for retry when $label",
    async ({ getSession }) => {
      const router = createAppRouter({ getSession })

      await router.push("/security/authorized-apps")

      expect(router.currentRoute.value.name).toBe("authorized-apps")
      expect(router.currentRoute.value.name).not.toBe("login")
    },
  )

  it("restores scroll positions and focuses the destination heading", async () => {
    window.history.replaceState({}, "", "/security/audit-log")

    const router = createAppRouter({
      getSession: async () => ({ data: { session: {} } }),
    })
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

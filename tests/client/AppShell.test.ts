import AppShell from "@client/components/layout/AppShell.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"

const authMocks = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<{ error: unknown }>>(),
}))

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    signOut: authMocks.signOut,
  },
}))

vi.mock("@client/features/security/BackupStatusNotice.vue", () => ({
  default: {
    name: "BackupStatusNotice",
    template: '<div data-testid="backup-status-notice-stub" />',
  },
}))

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { component: { template: "<div />" }, path: "/" },
      {
        component: { template: "<div />" },
        path: "/security/authorized-apps",
      },
      {
        component: { template: "<div />" },
        path: "/security/audit-log",
      },
      { component: { template: "<div />" }, path: "/login" },
    ],
  })
}

describe("AppShell", () => {
  beforeEach(() => {
    authMocks.signOut.mockReset()
  })

  it("provides navigation to access, authorized apps, and audit views", async () => {
    const router = createTestRouter()
    await router.push("/")
    const wrapper = mount(AppShell, {
      global: { plugins: [router] },
    })

    expect(wrapper.get('a[href="/"]').text()).toContain("eruoo")
    expect(wrapper.get('a[href="/security/authorized-apps"]').text()).toContain(
      "应用",
    )
    expect(wrapper.get('a[href="/security/audit-log"]').text()).toContain(
      "审计",
    )
    expect(wrapper.get('[aria-label="主题模式"]').attributes("role")).toBe(
      "group",
    )
    expect(
      wrapper.find('[data-testid="backup-status-notice-stub"]').exists(),
    ).toBe(true)

    wrapper.unmount()
  })

  it("shows and removes a marked GitHub reauthentication callback error", async () => {
    const router = createTestRouter()
    await router.push(
      "/?reauthentication=github&error=access_denied&error_description=synthetic",
    )
    const wrapper = mount(AppShell, {
      attachTo: document.body,
      global: { plugins: [router] },
    })

    expect(wrapper.get('[role="alert"]').text()).toContain(
      "GitHub 身份确认未完成",
    )

    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
    expect(wrapper.get('[role="alert"]').text()).not.toContain("synthetic")

    const dismissButton = wrapper.get(
      'button[aria-label="关闭 GitHub 身份确认失败提示"]',
    )
    const dismissButtonElement = dismissButton.element as HTMLElement
    dismissButtonElement.focus()
    expect(document.activeElement).toBe(dismissButtonElement)

    await dismissButton.trigger("click")
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get("#main-content").element)

    wrapper.unmount()
  })

  it("explains an exact owner rejection without exposing upstream detail", async () => {
    const router = createTestRouter()
    await router.push(
      "/?tab=security&reauthentication=github&error=owner_not_allowed&error_description=private-upstream-detail",
    )
    const wrapper = mount(AppShell, {
      global: { plugins: [router] },
    })

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain("当前 GitHub 账号不是此服务允许的 owner")
    expect(alert.text()).toContain("改用已配置的 owner 账号")
    expect(alert.text()).not.toContain("private-upstream-detail")

    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ tab: "security" })

    wrapper.unmount()
  })

  it.each([
    [
      "duplicated owner errors",
      "error=owner_not_allowed&error=owner_not_allowed",
    ],
    ["mixed errors", "error=owner_not_allowed&error=access_denied"],
  ])("uses generic feedback for %s", async (_label, errorQuery) => {
    const router = createTestRouter()
    await router.push(`/?reauthentication=github&${errorQuery}`)
    const wrapper = mount(AppShell, {
      global: { plugins: [router] },
    })

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain("GitHub 身份确认未完成")
    expect(alert.text()).not.toContain("当前 GitHub 账号不是")

    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})

    wrapper.unmount()
  })
})

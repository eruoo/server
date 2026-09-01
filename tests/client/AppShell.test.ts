import AppShell from "@client/components/layout/AppShell.vue"
import type { DatabaseBackupStatus } from "@client/features/security/backup-status-service"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { h, nextTick, onMounted, shallowRef } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"

const authMocks = vi.hoisted(() => ({
  signOut: vi.fn<() => Promise<{ error: unknown }>>(),
}))

const backupStatusMocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<DatabaseBackupStatus>>(),
}))

const sessionState = shallowRef({
  data: null as { user: { name: string } } | null,
  error: null as unknown,
  isPending: true,
  isRefetching: false,
  refetch: vi.fn<() => Promise<void>>(async () => {}),
})

vi.mock("@client/lib/auth-client", () => ({
  authClient: {
    signOut: authMocks.signOut,
    useSession: () => sessionState,
  },
}))

vi.mock("@client/features/security/backup-status-service", () => ({
  backupStatusService: {
    get: backupStatusMocks.get,
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
    backupStatusMocks.get.mockReset()
    backupStatusMocks.get.mockResolvedValue({
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    })
    sessionState.value = {
      data: null,
      error: null,
      isPending: true,
      isRefetching: false,
      refetch: vi.fn<() => Promise<void>>(async () => {}),
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("provides navigation to access, authorized apps, and audit views", async () => {
    sessionState.value = {
      ...sessionState.value,
      data: { user: { name: "Synthetic Owner" } },
      isPending: false,
    }
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
    await flushPromises()
    expect(backupStatusMocks.get).toHaveBeenCalledOnce()

    wrapper.unmount()
  })

  it("waits for a confirmed Session before mounting owner-only content", async () => {
    const ownerPanelMounted = vi.fn<() => void>()
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus")
    const OwnerPanel = {
      setup() {
        onMounted(ownerPanelMounted)
        return () =>
          h(
            "h1",
            {
              "data-route-heading": "",
              "data-testid": "owner-panel",
              tabindex: -1,
            },
            "Owner panel",
          )
      },
    }
    const router = createTestRouter()
    await router.push("/security/authorized-apps")
    const wrapper = mount(AppShell, {
      global: { plugins: [router] },
      slots: { default: () => h(OwnerPanel) },
    })

    try {
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(false)
      expect(ownerPanelMounted).not.toHaveBeenCalled()
      expect(backupStatusMocks.get).not.toHaveBeenCalled()

      sessionState.value = {
        ...sessionState.value,
        error: { status: 503 },
        isPending: false,
      }
      await nextTick()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(false)
      expect(ownerPanelMounted).not.toHaveBeenCalled()
      expect(backupStatusMocks.get).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain("暂时无法验证 Session")

      await wrapper.get(".session-boundary-action").trigger("click")
      expect(sessionState.value.refetch).toHaveBeenCalledOnce()

      sessionState.value = {
        ...sessionState.value,
        data: { user: { name: "Synthetic Owner" } },
        error: null,
        isRefetching: true,
      }
      await nextTick()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(false)
      expect(ownerPanelMounted).not.toHaveBeenCalled()
      expect(backupStatusMocks.get).not.toHaveBeenCalled()

      sessionState.value = {
        ...sessionState.value,
        isRefetching: false,
      }
      await nextTick()
      await flushPromises()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(true)
      expect(ownerPanelMounted).toHaveBeenCalledOnce()
      expect(backupStatusMocks.get).toHaveBeenCalledOnce()
      expect(focusSpy).toHaveBeenCalledOnce()

      sessionState.value = {
        ...sessionState.value,
        isRefetching: true,
      }
      await nextTick()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(true)
      expect(wrapper.get(".session-content").attributes("style")).toContain(
        "display: none",
      )
      expect(ownerPanelMounted).toHaveBeenCalledOnce()
      expect(backupStatusMocks.get).toHaveBeenCalledOnce()
      expect(wrapper.text()).toContain("正在验证 Session")

      sessionState.value = {
        ...sessionState.value,
        error: { status: 503 },
        isRefetching: false,
      }
      await nextTick()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(true)
      expect(wrapper.get(".session-content").attributes("style")).toContain(
        "display: none",
      )
      expect(wrapper.text()).toContain("暂时无法验证 Session")

      sessionState.value = {
        ...sessionState.value,
        error: null,
        isRefetching: false,
      }
      await nextTick()
      await flushPromises()
      expect(wrapper.find('[data-testid="owner-panel"]').exists()).toBe(true)
      expect(
        wrapper.get(".session-content").attributes("style"),
      ).toBeUndefined()
      expect(ownerPanelMounted).toHaveBeenCalledOnce()
      expect(backupStatusMocks.get).toHaveBeenCalledOnce()
      expect(focusSpy).toHaveBeenCalledOnce()
    } finally {
      wrapper.unmount()
    }
  })

  it("does not race a foreground Session refetch with backup status", async () => {
    let now = Date.parse("2026-08-21T03:05:00.000Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
    backupStatusMocks.get.mockResolvedValue({
      errorCode: "backup_upload_failed",
      lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
      lastSuccessAt: null,
      status: "failed",
    })
    sessionState.value = {
      ...sessionState.value,
      data: { user: { name: "Synthetic Owner" } },
      isPending: false,
    }

    const beginSessionRefetch = () => {
      queueMicrotask(() => {
        sessionState.value = {
          ...sessionState.value,
          error: null,
          isRefetching: true,
        }
      })
    }
    document.addEventListener("visibilitychange", beginSessionRefetch)

    const router = createTestRouter()
    await router.push("/")
    const wrapper = mount(AppShell, {
      global: { plugins: [router] },
    })

    try {
      await flushPromises()
      expect(backupStatusMocks.get).toHaveBeenCalledOnce()

      now += 5 * 60 * 1000
      document.dispatchEvent(new Event("visibilitychange"))
      await flushPromises()

      expect(sessionState.value.isRefetching).toBe(true)
      expect(backupStatusMocks.get).toHaveBeenCalledOnce()
    } finally {
      document.removeEventListener("visibilitychange", beginSessionRefetch)
      wrapper.unmount()
    }
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

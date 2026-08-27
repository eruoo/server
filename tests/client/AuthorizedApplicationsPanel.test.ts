import {
  AuthorizedApplicationsApiError,
  type AuthorizedApplication,
} from "@client/features/security/authorized-applications-service"
import AuthorizedApplicationsPanel from "@client/features/security/AuthorizedApplicationsPanel.vue"
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const serviceMocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<readonly AuthorizedApplication[]>>(),
  revoke:
    vi.fn<(clientId: AuthorizedApplication["clientId"]) => Promise<void>>(),
}))

vi.mock(
  "@client/features/security/authorized-applications-service",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@client/features/security/authorized-applications-service")
      >()

    return {
      ...original,
      authorizedApplicationsService: serviceMocks,
    }
  },
)

function application(
  input: Partial<AuthorizedApplication> &
    Pick<
      AuthorizedApplication,
      "clientId" | "name" | "platform" | "supportsOfflineAccess"
    >,
): AuthorizedApplication {
  return {
    activeRefreshTokenCount: 0,
    authorized: false,
    consentCount: 0,
    enabled: true,
    lastAuthorizedAt: null,
    offlineAccess: false,
    resources: [],
    scopes: [],
    ...input,
  }
}

const managedApplications: readonly AuthorizedApplication[] = [
  application({
    authorized: true,
    clientId: "eruoo-web",
    consentCount: 1,
    lastAuthorizedAt: Date.parse("2026-08-20T02:00:00.000Z"),
    name: "Web",
    platform: "web",
    scopes: ["openid"],
    supportsOfflineAccess: false,
  }),
  application({
    authorized: true,
    clientId: "eruoo-desktop",
    consentCount: 1,
    lastAuthorizedAt: Date.parse("2026-08-21T03:04:05.000Z"),
    name: "Desktop",
    offlineAccess: true,
    platform: "desktop",
    scopes: ["offline_access", "openid"],
    supportsOfflineAccess: true,
  }),
  application({
    clientId: "eruoo-mobile",
    name: "Mobile",
    platform: "mobile",
    supportsOfflineAccess: true,
  }),
]

describe("AuthorizedApplicationsPanel", () => {
  beforeEach(() => {
    serviceMocks.list.mockReset()
    serviceMocks.revoke.mockReset()
  })

  it("shows Web, Desktop, and Mobile authorization and offline status", async () => {
    serviceMocks.list.mockResolvedValue(managedApplications)
    const wrapper = mount(AuthorizedApplicationsPanel)

    await flushPromises()

    const cards = wrapper.findAll(".application-card")
    expect(cards).toHaveLength(3)
    expect(cards[0]?.text()).toContain("Web")
    expect(cards[0]?.text()).toContain("已授权")
    expect(cards[0]?.text()).not.toContain("离线访问")
    expect(cards[0]?.find('button[aria-label="撤销 Web 授权"]').exists()).toBe(
      false,
    )
    expect(cards[1]?.text()).toContain("Desktop")
    expect(cards[1]?.text()).toContain("离线访问：已授权")
    expect(cards[1]?.text()).toContain("UTC+8")
    expect(
      cards[1]?.find('button[aria-label="撤销 Desktop 授权"]').exists(),
    ).toBe(true)
    expect(cards[2]?.text()).toContain("Mobile")
    expect(cards[2]?.text()).toContain("未授权")
    expect(cards[2]?.text()).toContain("离线访问：未授权")
    expect(
      cards[2]?.find('button[aria-label="撤销 Mobile 授权"]').exists(),
    ).toBe(false)

    wrapper.unmount()
  })

  it("fails closed when authorization state cannot be verified", async () => {
    serviceMocks.list.mockRejectedValue(new Error("invalid response"))
    const wrapper = mount(AuthorizedApplicationsPanel)

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(
      "无法验证应用授权状态",
    )
    expect(wrapper.text()).toContain("应用授权列表暂时不可用")
    expect(wrapper.find('button[aria-label^="撤销"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it("offers sign-in when listing applications detects an expired Session", async () => {
    serviceMocks.list.mockRejectedValue(
      new AuthorizedApplicationsApiError("A valid owner Session is required.", {
        detail: "A valid owner Session is required.",
        requestId: "synthetic-request-id",
        status: 401,
        title: "Authentication required",
        type: "https://auth.eruoo.me/problems/authentication-required",
      }),
    )
    const wrapper = mount(AuthorizedApplicationsPanel, {
      global: {
        stubs: {
          RouterLink: {
            props: ["to"],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    })

    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
    expect(wrapper.text()).not.toContain("列表暂时不可用")

    wrapper.unmount()
  })

  it("requires explicit confirmation before revoking all client consents", async () => {
    serviceMocks.list.mockResolvedValue(managedApplications)
    serviceMocks.revoke.mockResolvedValue()
    const wrapper = mount(AuthorizedApplicationsPanel, {
      attachTo: document.body,
    })

    await flushPromises()
    await wrapper.get('button[aria-label="撤销 Desktop 授权"]').trigger("click")

    expect(serviceMocks.revoke).not.toHaveBeenCalled()
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    expect(confirmButton).toBeDefined()

    confirmButton?.click()
    await flushPromises()

    expect(serviceMocks.revoke).toHaveBeenCalledOnce()
    expect(serviceMocks.revoke).toHaveBeenCalledWith("eruoo-desktop")
    expect(wrapper.text()).toContain("已撤销 Desktop 的长期授权")
    expect(
      wrapper.find('button[aria-label="撤销 Desktop 授权"]').exists(),
    ).toBe(false)

    wrapper.unmount()
  })

  it("pauses a denied revocation until recent authentication succeeds", async () => {
    serviceMocks.list.mockResolvedValue(managedApplications)
    serviceMocks.revoke.mockRejectedValue({
      status: 403,
      type: "https://auth.eruoo.me/problems/recent-authentication-required",
    })
    const wrapper = mount(AuthorizedApplicationsPanel, {
      attachTo: document.body,
    })

    await flushPromises()
    await wrapper.get('button[aria-label="撤销 Desktop 授权"]').trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.text()).toContain("请先重新确认身份")
    expect(wrapper.text()).toContain("需要重新确认身份")
    expect(
      wrapper.find('button[aria-label="撤销 Desktop 授权"]').exists(),
    ).toBe(true)

    wrapper.unmount()
  })

  it("keeps the application available when revocation has a service failure", async () => {
    serviceMocks.list.mockResolvedValue(managedApplications)
    serviceMocks.revoke.mockRejectedValue(new Error("service unavailable"))
    const wrapper = mount(AuthorizedApplicationsPanel, {
      attachTo: document.body,
    })

    await flushPromises()
    await wrapper.get('button[aria-label="撤销 Desktop 授权"]').trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(
      "无法撤销 Desktop 授权",
    )
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(
      wrapper.find('button[aria-label="撤销 Desktop 授权"]').exists(),
    ).toBe(true)

    wrapper.unmount()
  })

  it("offers sign-in when revocation detects an expired Session", async () => {
    serviceMocks.list.mockResolvedValue(managedApplications)
    serviceMocks.revoke.mockRejectedValue(
      new AuthorizedApplicationsApiError("A valid owner Session is required.", {
        detail: "A valid owner Session is required.",
        requestId: "synthetic-request-id",
        status: 401,
        title: "Invalid credential",
        type: "https://auth.eruoo.me/problems/invalid-credential",
      }),
    )
    const wrapper = mount(AuthorizedApplicationsPanel, {
      attachTo: document.body,
      global: {
        stubs: {
          RouterLink: {
            props: ["to"],
            template: '<a :href="to"><slot /></a>',
          },
        },
      },
    })

    await flushPromises()
    await wrapper.get('button[aria-label="撤销 Desktop 授权"]').trigger("click")
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("确认撤销"),
    )
    confirmButton?.click()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain("Session 已失效")
    expect(wrapper.get('a[href="/login"]').text()).toBe("重新登录")
    expect(wrapper.find(".application-card").exists()).toBe(false)

    wrapper.unmount()
  })
})

import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, it, vi } from "vitest"

import App from "../../src/client/App.vue"
import { router } from "../../src/client/router"

afterEach(() => vi.restoreAllMocks())

it.each([
  { leave: false, outcome: "success" },
  { leave: false, outcome: "invalid_signature" },
  { leave: true, outcome: "success" },
  { leave: true, outcome: "invalid_signature" },
  { leave: true, outcome: "network_failure" },
])(
  "keeps GitHub results with their initiating route ($outcome, leave: $leave)",
  async ({ leave, outcome }) => {
    await router.push("/login")
    await router.isReady()
    let finish!: (response: Response) => void
    let fail!: (error: Error) => void
    let requested!: () => void
    const started = new Promise<void>((resolve) => (requested = resolve))
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("sign-in/social")) {
        requested()
        return new Promise((resolve, reject) => {
          finish = resolve
          fail = reject
        })
      }
      return Response.json(null)
    })
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined)
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => undefined)
    const wrapper = mount(App, { global: { plugins: [router] } })
    try {
      await flushPromises()
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "使用 GitHub 登录")!
        .trigger("click")
      await started
      if (leave) {
        await wrapper.get('a[href="/security/passkeys"]').trigger("click")
      }
      await vi.waitFor(() =>
        expect(router.currentRoute.value.path).toBe(
          leave ? "/security/passkeys" : "/login",
        ),
      )
      await flushPromises()
      if (outcome === "network_failure") fail(new Error("Network unavailable"))
      else
        finish(
          outcome === "success"
            ? Response.json({
                redirect: true,
                url: "https://github.com/login/oauth/authorize?client_id=synthetic",
              })
            : Response.json({ code: "invalid_signature" }, { status: 400 }),
        )
      await flushPromises()
      expect(assign).toHaveBeenCalledTimes(
        !leave && outcome === "success" ? 1 : 0,
      )
      expect(replace).toHaveBeenCalledTimes(
        !leave && outcome === "invalid_signature" ? 1 : 0,
      )
      expect(wrapper.text().includes("请先登录")).toBe(leave)
      expect(wrapper.text().includes("授权已失效")).toBe(
        !leave && outcome === "invalid_signature",
      )
      expect(wrapper.text()).not.toContain("身份验证未完成")
      const login = wrapper
        .findAll("button")
        .find((button) => button.text() === "使用 GitHub 登录")!
      expect(login.exists()).toBe(true)
      expect(login.attributes("disabled") !== undefined).toBe(
        !leave && outcome === "success",
      )
    } finally {
      wrapper.unmount()
    }
  },
)

it("keeps the shared Session check alive when the route changes", async () => {
  await router.push("/login")
  let finish!: (response: Response) => void
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input) =>
      String(input).includes("/get-session")
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve(Response.json([])),
    )
  const wrapper = mount(App, { global: { plugins: [router] } })
  try {
    await wrapper.get('a[href="/security/passkeys"]').trigger("click")
    await vi.waitFor(() =>
      expect(router.currentRoute.value.path).toBe("/security/passkeys"),
    )
    await flushPromises()
    finish(
      Response.json({
        user: { id: "owner", name: "Owner", email: "owner@example.invalid" },
        session: { id: "session", userId: "owner" },
      }),
    )
    await flushPromises()
    expect(router.currentRoute.value.path).toBe("/security/passkeys")
    expect(wrapper.find('[aria-label="账号菜单"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain("请先登录")
    expect(
      fetch.mock.calls.filter(([input]) =>
        String(input).includes("/get-session"),
      ),
    ).toHaveLength(1)
  } finally {
    wrapper.unmount()
  }
})

import LoginPanel from "@client/features/auth/LoginPanel.vue"
import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

function findButtonByName(
  wrapper: ReturnType<typeof mount>,
  accessibleName: string,
) {
  return wrapper
    .findAll("button")
    .find((button) => button.text().trim() === accessibleName)
}

describe("LoginPanel", () => {
  it("explains the available owner sign-in methods", () => {
    const wrapper = mount(LoginPanel)

    expect(wrapper.get("h1").text()).toBe("确认 owner 身份")
    expect(wrapper.text()).toContain(
      "GitHub 用于首次引导和恢复；Passkey 是日常登录方式。",
    )
    expect(findButtonByName(wrapper, "使用 Passkey")?.exists()).toBe(true)
    expect(findButtonByName(wrapper, "使用 GitHub")?.exists()).toBe(true)
  })

  it("requests Passkey authentication when the user selects it", async () => {
    const wrapper = mount(LoginPanel)
    const passkeyButton = findButtonByName(wrapper, "使用 Passkey")

    expect(passkeyButton).toBeDefined()
    await passkeyButton?.trigger("click")

    expect(wrapper.emitted("passkey")).toEqual([[]])
  })

  it("requests GitHub authentication when the user selects it", async () => {
    const wrapper = mount(LoginPanel)
    const githubButton = findButtonByName(wrapper, "使用 GitHub")

    expect(githubButton).toBeDefined()
    await githubButton?.trigger("click")

    expect(wrapper.emitted("github")).toEqual([[]])
  })

  it("announces the active authentication method while sign-in is pending", () => {
    const wrapper = mount(LoginPanel, {
      props: {
        disabled: true,
        pendingMethod: "passkey",
      },
    })

    expect(wrapper.get("section").attributes("aria-busy")).toBe("true")
    expect(wrapper.text()).toContain("正在验证 Passkey…")
    expect(wrapper.text()).toContain("使用 GitHub")
    expect(
      wrapper
        .findAll("button")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true)
    expect(
      findButtonByName(wrapper, "正在验证 Passkey…")?.attributes("aria-busy"),
    ).toBe("true")
  })
})

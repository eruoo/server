import ThemeSchemeControl from "@client/components/theme/ThemeSchemeControl.vue"
import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { nextTick } from "vue"

describe("ThemeSchemeControl", () => {
  it("announces the active scheme and emits an explicit selection", async () => {
    const wrapper = mount(ThemeSchemeControl, {
      props: { scheme: "system" },
    })

    expect(
      wrapper
        .get('button[aria-label="跟随系统主题"]')
        .attributes("aria-pressed"),
    ).toBe("true")

    await wrapper.get('button[aria-label="使用深色主题"]').trigger("click")

    expect(wrapper.emitted("select")).toEqual([["dark"]])
  })

  it("moves entry focus to the active option for keyboard users", async () => {
    const wrapper = mount(ThemeSchemeControl, {
      attachTo: document.body,
      props: { scheme: "system" },
    })
    const systemButton = wrapper.get('button[aria-label="跟随系统主题"]')
    const lightButton = wrapper.get('button[aria-label="使用浅色主题"]')
    const group = wrapper.get('[aria-label="主题模式"]')

    await nextTick()

    expect(group.attributes("tabindex")).toBe("0")
    expect(systemButton.attributes("tabindex")).toBe("-1")
    expect(lightButton.attributes("tabindex")).toBe("-1")
    expect(systemButton.attributes("data-orientation")).toBe("horizontal")
    expect(group.attributes("role")).toBe("group")

    ;(group.element as HTMLElement).focus()
    await nextTick()
    expect(document.activeElement).toBe(systemButton.element)

    await systemButton.trigger("keydown", { key: "ArrowRight" })
    await nextTick()
    expect(document.activeElement).toBe(lightButton.element)
    wrapper.unmount()
  })
})

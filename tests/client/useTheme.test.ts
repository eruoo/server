import {
  initializeTheme,
  themeStorageKey,
  useTheme,
} from "@client/composables/useTheme"
import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defineComponent, h, nextTick } from "vue"

function createMediaQuery(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()

  const query = {
    addEventListener: vi.fn<
      (type: string, listener: (event: MediaQueryListEvent) => void) => void
    >((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.add(listener)
    }),
    addListener: vi.fn<(listener: () => void) => void>(),
    dispatchEvent: vi.fn<(event: Event) => boolean>(() => true),
    get matches() {
      return matches
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    removeEventListener: vi.fn<
      (type: string, listener: (event: MediaQueryListEvent) => void) => void
    >((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.delete(listener)
    }),
    removeListener: vi.fn<(listener: () => void) => void>(),
  } as unknown as MediaQueryList

  return {
    emit(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches, media: query.media } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    },
    query,
  }
}

function mountThemeHarness() {
  let theme: ReturnType<typeof useTheme> | undefined
  const wrapper = mount(
    defineComponent({
      setup() {
        theme = useTheme()
        return () => h("div", theme?.scheme.value)
      },
    }),
  )

  if (!theme) throw new Error("Theme composable did not initialize.")
  return { theme, wrapper }
}

describe("useTheme", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.className = ""
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
    document.documentElement.className = ""
  })

  it("applies a stored explicit scheme before the Vue app mounts", () => {
    const media = createMediaQuery(false)
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media.query),
    )
    window.localStorage.setItem(themeStorageKey, "dark")

    initializeTheme()

    expect(document.documentElement.classList.contains("brutal")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("falls back to system and follows system changes until overridden", async () => {
    const media = createMediaQuery(false)
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media.query),
    )
    window.localStorage.setItem(themeStorageKey, "unsupported")
    initializeTheme()
    const { theme, wrapper } = mountThemeHarness()

    expect(theme.scheme.value).toBe("system")
    expect(document.documentElement.className.split(/\s+/)).toContain("brutal")
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    media.emit(true)
    await nextTick()
    expect(theme.isDark.value).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    theme.setScheme("light")
    await nextTick()
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light")
    expect(document.documentElement.classList.contains("brutal")).toBe(true)
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    media.emit(false)
    media.emit(true)
    await nextTick()
    expect(document.documentElement.classList.contains("dark")).toBe(false)

    theme.setScheme("system")
    await nextTick()
    expect(document.documentElement.classList.contains("dark")).toBe(true)

    wrapper.unmount()
    expect(media.query.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    )
  })
})

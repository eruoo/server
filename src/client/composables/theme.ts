import { computed, onMounted, onUnmounted, shallowRef, watch } from "vue"
import type { ComputedRef, InjectionKey } from "vue"

type ThemePreference = "system" | "light" | "dark"

export const darkThemeKey: InjectionKey<ComputedRef<boolean>> =
  Symbol("darkTheme")

function storedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem("theme")
    if (value === "light" || value === "dark") return value
  } catch {
    /* Storage is optional for appearance. */
  }
  return "system"
}

export function useThemePreference() {
  const preference = shallowRef(storedTheme())
  const colorScheme = matchMedia("(prefers-color-scheme: dark)")
  const systemDark = shallowRef(colorScheme.matches)
  const isDark = computed(
    () =>
      preference.value === "dark" ||
      (preference.value === "system" && systemDark.value),
  )

  watch(
    [preference, isDark],
    () => {
      document.documentElement.dataset.theme = preference.value
      document.documentElement.classList.add("brutal")
      document.documentElement.classList.toggle("dark", isDark.value)
      try {
        localStorage.setItem("theme", preference.value)
      } catch {
        /* Storage is optional for appearance. */
      }
    },
    { immediate: true, flush: "sync" },
  )

  function updateSystemTheme() {
    systemDark.value = colorScheme.matches
  }
  onMounted(() => colorScheme.addEventListener("change", updateSystemTheme))
  onUnmounted(() =>
    colorScheme.removeEventListener("change", updateSystemTheme),
  )

  return { preference, isDark }
}

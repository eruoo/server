import { computed, onMounted, onUnmounted, readonly, shallowRef } from "vue"

export const themeStorageKey = "eruoo.theme.scheme"

export const themeSchemes = ["system", "light", "dark"] as const

export type ThemeScheme = (typeof themeSchemes)[number]

const scheme = shallowRef<ThemeScheme>("system")
const systemPrefersDark = shallowRef(false)

let activeConsumers = 0
let mediaQuery: MediaQueryList | undefined

function isThemeScheme(value: unknown): value is ThemeScheme {
  return themeSchemes.some((scheme) => scheme === value)
}

function getSystemThemeQuery(): MediaQueryList | undefined {
  if (typeof window === "undefined" || !window.matchMedia) return

  try {
    return window.matchMedia("(prefers-color-scheme: dark)")
  } catch {
    return
  }
}

function readStoredScheme(): ThemeScheme {
  if (typeof window === "undefined") return "system"

  try {
    const storedScheme = window.localStorage.getItem(themeStorageKey)
    return isThemeScheme(storedScheme) ? storedScheme : "system"
  } catch {
    return "system"
  }
}

function writeStoredScheme(nextScheme: ThemeScheme): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(themeStorageKey, nextScheme)
  } catch {
    // A blocked or full storage area must not prevent theme selection.
  }
}

function resolvedDarkMode(): boolean {
  return (
    scheme.value === "dark" ||
    (scheme.value === "system" && systemPrefersDark.value)
  )
}

function applyRootClasses(): void {
  if (typeof document === "undefined") return

  document.documentElement.classList.add("brutal")
  document.documentElement.classList.toggle("dark", resolvedDarkMode())
}

function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemPrefersDark.value = event.matches

  if (scheme.value === "system") {
    applyRootClasses()
  }
}

function startSystemThemeListener(): void {
  activeConsumers += 1
  if (activeConsumers > 1) return

  mediaQuery = getSystemThemeQuery()
  if (!mediaQuery) return

  systemPrefersDark.value = mediaQuery.matches
  mediaQuery.addEventListener("change", handleSystemThemeChange)

  if (scheme.value === "system") {
    applyRootClasses()
  }
}

function stopSystemThemeListener(): void {
  activeConsumers = Math.max(0, activeConsumers - 1)
  if (activeConsumers > 0 || !mediaQuery) return

  mediaQuery.removeEventListener("change", handleSystemThemeChange)
  mediaQuery = undefined
}

export function initializeTheme(): void {
  scheme.value = readStoredScheme()
  systemPrefersDark.value = getSystemThemeQuery()?.matches ?? false
  applyRootClasses()
}

export function useTheme() {
  if (typeof document !== "undefined") {
    applyRootClasses()
  }

  const isDark = computed(resolvedDarkMode)

  function setScheme(nextScheme: ThemeScheme): void {
    scheme.value = nextScheme
    writeStoredScheme(nextScheme)
    applyRootClasses()
  }

  onMounted(startSystemThemeListener)
  onUnmounted(stopSystemThemeListener)

  return {
    isDark,
    scheme: readonly(scheme),
    setScheme,
  }
}

<script setup lang="ts">
import { onMounted, onUnmounted, provide, shallowRef, watch } from "vue"
import { useRoute } from "vue-router"

import { createSessionController, sessionKey } from "./composables/session"
const session = createSessionController()
provide(sessionKey, session)
const route = useRoute()
watch(() => route.fullPath, session.cancelAuthentication, { flush: "sync" })
function storedTheme() {
  try {
    const value = localStorage.getItem("theme")
    return value && ["system", "light", "dark"].includes(value)
      ? value
      : "system"
  } catch {
    return "system"
  }
}
const theme = shallowRef(storedTheme())
const colorScheme = matchMedia("(prefers-color-scheme: dark)")
function applyTheme() {
  document.documentElement.dataset.theme = theme.value
  document.documentElement.classList.toggle(
    "dark",
    theme.value === "dark" || (theme.value === "system" && colorScheme.matches),
  )
  try {
    localStorage.setItem("theme", theme.value)
  } catch {
    /* Storage is optional for appearance. */
  }
}
function onVisibility() {
  if (document.visibilityState === "visible") void session.refresh()
}
onMounted(() => {
  applyTheme()
  colorScheme.addEventListener("change", applyTheme)
  void session.refresh(true)
  document.addEventListener("visibilitychange", onVisibility)
})
onUnmounted(() => {
  colorScheme.removeEventListener("change", applyTheme)
  session.invalidate()
  document.removeEventListener("visibilitychange", onVisibility)
})
</script>

<template>
  <header class="shell-header">
    <RouterLink to="/" class="brand">eruoo<span>管理控制台</span></RouterLink>
    <label class="theme-control"
      >外观
      <select v-model="theme" @change="applyTheme">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  </header>
  <nav class="shell-nav" aria-label="管理导航">
    <RouterLink to="/security/passkeys">Passkey</RouterLink
    ><RouterLink to="/security/audit-log">安全审计</RouterLink
    ><RouterLink to="/security/authorized-apps">已授权应用</RouterLink
    ><RouterLink to="/security/api-keys">API Key</RouterLink
    ><RouterLink to="/api/docs">API 文档</RouterLink
    ><RouterLink to="/account">账号</RouterLink>
  </nav>
  <main class="shell-content"><RouterView /></main>
  <footer>eruoo · 私有身份服务</footer>
</template>

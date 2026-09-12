<script setup lang="ts">
import { onMounted, onUnmounted, provide, watch } from "vue"
import { useRoute } from "vue-router"

import { createSessionController, sessionKey } from "./composables/session"
import { darkThemeKey, useThemePreference } from "./composables/theme"
const session = createSessionController()
provide(sessionKey, session)
const { preference: theme, isDark } = useThemePreference()
provide(darkThemeKey, isDark)
const route = useRoute()
watch(() => route.fullPath, session.cancelAuthentication, { flush: "sync" })
function onVisibility() {
  if (document.visibilityState === "visible") void session.refresh()
}
onMounted(() => {
  void session.refresh(true)
  document.addEventListener("visibilitychange", onVisibility)
})
onUnmounted(() => {
  session.invalidate()
  document.removeEventListener("visibilitychange", onVisibility)
})
</script>

<template>
  <header class="shell-header">
    <RouterLink to="/" class="brand">eruoo<span>管理控制台</span></RouterLink>
    <label class="theme-control"
      >外观
      <select v-model="theme">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  </header>
  <nav class="shell-nav" aria-label="管理导航">
    <RouterLink to="/security/passkeys" class="pressable">Passkey</RouterLink
    ><RouterLink to="/security/audit-log" class="pressable">安全审计</RouterLink
    ><RouterLink to="/security/authorized-apps" class="pressable"
      >已授权应用</RouterLink
    ><RouterLink to="/security/api-keys" class="pressable">API Key</RouterLink
    ><RouterLink to="/api/docs" class="pressable">API 文档</RouterLink
    ><RouterLink to="/account" class="pressable">账号</RouterLink>
  </nav>
  <main class="shell-content"><RouterView /></main>
  <footer>eruoo · 私有身份服务</footer>
</template>

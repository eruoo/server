<script setup lang="ts">
import { onMounted, onUnmounted, provide, watch } from "vue"
import { useRoute } from "vue-router"

import AccountMenu from "./components/layout/AccountMenu.vue"
import BackupStatusDialog from "./components/layout/BackupStatusDialog.vue"
import ThemeToggle from "./components/layout/ThemeToggle.vue"
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
    <div class="shell-actions">
      <ThemeToggle v-model="theme" />
      <AccountMenu v-if="session.data.value" />
    </div>
  </header>
  <nav class="shell-nav" aria-label="管理导航">
    <RouterLink to="/security/passkeys" class="pressable">Passkey</RouterLink
    ><RouterLink to="/security/audit-log" class="pressable">安全审计</RouterLink
    ><RouterLink to="/security/authorized-apps" class="pressable"
      >已授权应用</RouterLink
    ><RouterLink to="/security/api-keys" class="pressable">API Key</RouterLink
    ><RouterLink to="/api/docs" class="pressable">API 文档</RouterLink>
  </nav>
  <main class="shell-content"><RouterView /></main>
  <footer class="shell-footer">
    <span>eruoo · 私有身份服务</span>
    <BackupStatusDialog v-if="session.data.value" />
  </footer>
</template>

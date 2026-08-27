<script setup lang="ts">
import ThemeSchemeControl from "@client/components/theme/ThemeSchemeControl.vue"
import { useTheme } from "@client/composables/useTheme"
import BackupStatusNotice from "@client/features/security/BackupStatusNotice.vue"
import { authClient } from "@client/lib/auth-client"
import {
  AppWindow,
  KeyRound,
  LogOut,
  ScrollText,
  ShieldCheck,
  X,
} from "@lucide/vue"
import { nextTick, onMounted, shallowRef, useTemplateRef } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"

const router = useRouter()
const route = useRoute()
const { scheme, setScheme } = useTheme()
const isSigningOut = shallowRef(false)
const signOutError = shallowRef(false)
const mainContent = useTemplateRef<HTMLElement>("main-content")
const isGitHubReauthenticationCallback =
  route.query["reauthentication"] === "github"
const githubReauthenticationFailed = shallowRef(
  isGitHubReauthenticationCallback && typeof route.query["error"] === "string",
)

onMounted(() => {
  if (!isGitHubReauthenticationCallback) return

  const query = { ...route.query }
  delete query["error"]
  delete query["error_description"]
  delete query["reauthentication"]
  void router.replace({ query })
})

async function signOut() {
  signOutError.value = false
  isSigningOut.value = true

  try {
    const result = await authClient.signOut()

    if (result.error) {
      signOutError.value = true
      return
    }

    await router.replace("/login")
  } catch {
    signOutError.value = true
  } finally {
    isSigningOut.value = false
  }
}

async function dismissGitHubReauthenticationFailure(): Promise<void> {
  githubReauthenticationFailed.value = false
  await nextTick()
  mainContent.value?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="app-shell">
    <a class="skip-link focus-ring" href="#main-content">跳到主要内容</a>
    <header class="app-header">
      <RouterLink class="brand focus-ring" to="/">
        <ShieldCheck :size="24" stroke-width="2.5" aria-hidden="true" />
        <span>eruoo</span>
      </RouterLink>
      <div class="header-actions">
        <nav class="primary-navigation" aria-label="主要导航">
          <RouterLink class="nav-link focus-ring" to="/">
            <KeyRound :size="18" aria-hidden="true" />
            <span>访问</span>
          </RouterLink>
          <RouterLink
            class="nav-link focus-ring"
            to="/security/authorized-apps"
          >
            <AppWindow :size="18" aria-hidden="true" />
            <span>应用</span>
          </RouterLink>
          <RouterLink class="nav-link focus-ring" to="/security/audit-log">
            <ScrollText :size="18" aria-hidden="true" />
            <span>审计</span>
          </RouterLink>
          <button
            class="nav-link focus-ring"
            type="button"
            :disabled="isSigningOut"
            @click="signOut"
          >
            <LogOut :size="18" aria-hidden="true" />
            <span>{{ isSigningOut ? "退出中" : "退出" }}</span>
          </button>
        </nav>
        <ThemeSchemeControl :scheme="scheme" @select="setScheme" />
      </div>
    </header>
    <p v-if="signOutError" class="session-error" role="alert">
      退出失败，当前 Session 可能仍然有效，请重试。
    </p>
    <div v-if="githubReauthenticationFailed" class="session-error" role="alert">
      <span>
        GitHub 身份确认未完成。请返回刚才的操作并重试，或改用 Passkey。
      </span>
      <button
        class="session-error-dismiss focus-ring"
        type="button"
        aria-label="关闭 GitHub 身份确认失败提示"
        @click="dismissGitHubReauthenticationFailure"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </div>
    <BackupStatusNotice />
    <main id="main-content" ref="main-content" class="app-main" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100svh;
  background: var(--surface-canvas);
  color: var(--text-primary);
}

.skip-link {
  position: fixed;
  z-index: var(--z-overlay);
  inset-block-start: var(--spacing-3);
  inset-inline-start: var(--spacing-3);
  padding: var(--spacing-3) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-panel);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
  text-decoration: none;
  transform: translateY(calc(-100% - var(--spacing-6)));
}

.skip-link:focus {
  transform: translateY(0);
}

.app-header {
  display: flex;
  gap: var(--spacing-4);
  align-items: center;
  justify-content: space-between;
  min-height: 4.5rem;
  padding-inline: clamp(var(--spacing-4), 4vw, var(--spacing-10));
  border-bottom: var(--border-width-surface) solid var(--border-default);
  background: var(--surface-panel);
}

.brand,
.nav-link {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  color: var(--text-primary);
  text-decoration: none;
}

.brand {
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--font-weight-bold);
}

.header-actions,
.primary-navigation {
  display: flex;
  gap: var(--spacing-2);
  align-items: center;
}

.nav-link {
  appearance: none;
  padding: var(--spacing-2) var(--spacing-3);
  border: var(--border-width-thin) solid transparent;
  background: transparent;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
}

.nav-link:disabled {
  cursor: wait;
  opacity: 0.55;
}

.nav-link:hover,
.nav-link.router-link-exact-active {
  border-color: var(--border-default);
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.app-main {
  width: min(100% - 2rem, 76rem);
  margin-inline: auto;
}

.session-error {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  justify-content: space-between;
  width: min(100% - 2rem, 76rem);
  padding: var(--spacing-3) var(--spacing-4);
  margin: var(--spacing-4) auto 0;
  border: var(--border-width-control) solid var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
}

.session-error-dismiss {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: var(--touch-target-min);
  min-height: var(--touch-target-min);
  padding: var(--spacing-2);
  border: var(--border-width-thin) solid currentcolor;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

@media (width < 36rem) {
  .app-header {
    align-items: flex-start;
  }

  .header-actions {
    flex-direction: column-reverse;
    align-items: flex-end;
  }

  .nav-link {
    min-width: var(--touch-target-min);
    min-height: var(--touch-target-min);
    justify-content: center;
  }

  .nav-link span {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}
</style>

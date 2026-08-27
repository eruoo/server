<script setup lang="ts">
import RecentAuthenticationNotice from "@client/features/auth/RecentAuthenticationNotice.vue"
import {
  authorizedApplicationsService,
  type AuthorizedApplication,
  type ManagedApplicationPlatform,
} from "@client/features/security/authorized-applications-service"
import {
  requiresAuthentication,
  requiresRecentAuthentication,
} from "@client/lib/auth-errors"
import {
  AppWindow,
  Globe2,
  Laptop,
  RefreshCw,
  Smartphone,
  Trash2,
} from "@lucide/vue"
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "reka-ui"
import { onMounted, shallowRef } from "vue"
import type { Component } from "vue"
import { RouterLink } from "vue-router"

type LoadState = "authentication-required" | "error" | "loading" | "ready"

interface Feedback {
  kind: "error" | "success"
  message: string
}

const platformIcons: Record<ManagedApplicationPlatform, Component> = {
  desktop: Laptop,
  mobile: Smartphone,
  web: Globe2,
}

const applications = shallowRef<readonly AuthorizedApplication[]>([])
const loadState = shallowRef<LoadState>("loading")
const feedback = shallowRef<Feedback>()
const revokingClientId = shallowRef<string>()
const needsRecentAuthentication = shallowRef(false)

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
})

function formatAuthorizedAt(timestamp: number): string {
  return `${dateTimeFormatter.format(timestamp)} · UTC+8`
}

function isRevocableApplication(application: AuthorizedApplication): boolean {
  return (
    application.authorized &&
    application.supportsOfflineAccess &&
    (application.platform === "desktop" || application.platform === "mobile")
  )
}

function handleReauthenticated(): void {
  needsRecentAuthentication.value = false
  feedback.value = {
    kind: "success",
    message: "身份已重新确认，请再次执行刚才的撤销操作。",
  }
}

function reportRevokeError(
  application: AuthorizedApplication,
  error: unknown,
): void {
  if (requiresAuthentication(error)) {
    applications.value = []
    loadState.value = "authentication-required"
    needsRecentAuthentication.value = false
    feedback.value = undefined
    return
  }

  if (requiresRecentAuthentication(error)) {
    needsRecentAuthentication.value = true
    feedback.value = {
      kind: "error",
      message: "请先重新确认身份，再撤销这个应用授权。",
    }
    return
  }

  feedback.value = {
    kind: "error",
    message: `无法撤销 ${application.name} 授权，请稍后重试。`,
  }
}

async function loadApplications(): Promise<void> {
  loadState.value = "loading"
  feedback.value = undefined

  try {
    applications.value = await authorizedApplicationsService.list()
    loadState.value = "ready"
  } catch (error) {
    applications.value = []
    if (requiresAuthentication(error)) {
      loadState.value = "authentication-required"
      return
    }

    loadState.value = "error"
    feedback.value = {
      kind: "error",
      message: "无法验证应用授权状态。为确保安全，撤销操作已暂停。",
    }
  }
}

async function revokeApplication(
  application: AuthorizedApplication,
): Promise<void> {
  if (revokingClientId.value) return

  revokingClientId.value = application.clientId
  feedback.value = undefined

  try {
    await authorizedApplicationsService.revoke(application.clientId)
    applications.value = applications.value.map((candidate) => {
      if (candidate.clientId !== application.clientId) return candidate

      return {
        ...candidate,
        activeRefreshTokenCount: 0,
        authorized: false,
        consentCount: 0,
        lastAuthorizedAt: null,
        offlineAccess: false,
        resources: [],
        scopes: [],
      }
    })
    feedback.value = {
      kind: "success",
      message: `已撤销 ${application.name} 的长期授权。`,
    }
  } catch (error) {
    reportRevokeError(application, error)
  } finally {
    revokingClientId.value = undefined
  }
}

onMounted(loadApplications)
</script>

<template>
  <section
    class="authorized-applications"
    aria-labelledby="authorized-applications-title"
    :aria-busy="loadState === 'loading' || Boolean(revokingClientId)"
  >
    <header class="page-header">
      <div>
        <p class="eyebrow">CONNECTED ACCESS</p>
        <h1 id="authorized-applications-title" data-route-heading tabindex="-1">
          已授权应用
        </h1>
      </div>
      <AppWindow :size="38" stroke-width="2.25" aria-hidden="true" />
    </header>

    <p class="page-copy">
      查看 Web、Desktop 和 Mobile
      客户端的授权状态。撤销会终止该客户端的长期访问凭证。
    </p>

    <RecentAuthenticationNotice
      :visible="needsRecentAuthentication"
      @verified="handleReauthenticated"
    />

    <p
      v-if="feedback"
      class="feedback"
      :class="`feedback-${feedback.kind}`"
      :role="feedback.kind === 'error' ? 'alert' : 'status'"
      aria-live="polite"
    >
      {{ feedback.message }}
    </p>

    <div v-if="loadState === 'loading'" class="state-card" role="status">
      <span class="loading-mark" aria-hidden="true"></span>
      正在验证应用授权状态…
    </div>

    <div
      v-else-if="loadState === 'authentication-required'"
      class="state-card error-state"
      role="alert"
    >
      <div>
        <strong>Session 已失效。</strong>
        <p>重新登录后才能继续管理应用授权。</p>
      </div>
      <RouterLink class="secondary-button focus-ring" to="/login">
        重新登录
      </RouterLink>
    </div>

    <div v-else-if="loadState === 'error'" class="state-card error-state">
      <p>应用授权列表暂时不可用。</p>
      <button
        class="secondary-button focus-ring"
        type="button"
        @click="loadApplications"
      >
        <RefreshCw :size="18" aria-hidden="true" />
        重试
      </button>
    </div>

    <ul v-else class="application-list" aria-label="应用授权状态">
      <li
        v-for="application in applications"
        :key="application.clientId"
        class="application-card"
      >
        <div class="application-icon" aria-hidden="true">
          <component :is="platformIcons[application.platform]" :size="26" />
        </div>

        <div class="application-summary">
          <div class="application-title-row">
            <h2>{{ application.name }}</h2>
            <span
              class="status-badge"
              :class="
                application.authorized ? 'status-active' : 'status-inactive'
              "
            >
              {{ application.authorized ? "已授权" : "未授权" }}
            </span>
          </div>
          <code>{{ application.clientId }}</code>
          <p
            v-if="application.lastAuthorizedAt !== null"
            class="authorization-time"
          >
            最近授权：{{ formatAuthorizedAt(application.lastAuthorizedAt) }}
          </p>
          <p v-if="application.supportsOfflineAccess" class="offline-status">
            离线访问：{{ application.offlineAccess ? "已授权" : "未授权" }}
          </p>
          <ul
            v-if="application.scopes.length > 0"
            class="scope-list"
            aria-label="已授权范围"
          >
            <li v-for="scope in application.scopes" :key="scope">
              {{ scope }}
            </li>
          </ul>
        </div>

        <AlertDialogRoot v-if="isRevocableApplication(application)">
          <AlertDialogTrigger as-child>
            <button
              class="revoke-button focus-ring"
              type="button"
              :disabled="Boolean(revokingClientId)"
              :aria-label="`撤销 ${application.name} 授权`"
            >
              <Trash2 :size="18" aria-hidden="true" />
              撤销
            </button>
          </AlertDialogTrigger>

          <AlertDialogPortal>
            <AlertDialogOverlay class="dialog-overlay" />
            <AlertDialogContent class="dialog-content">
              <p class="dialog-eyebrow">SENSITIVE ACTION</p>
              <AlertDialogTitle class="dialog-title">
                撤销 {{ application.name }} 的长期授权？
              </AlertDialogTitle>
              <AlertDialogDescription class="dialog-description">
                该客户端的全部 refresh token
                将失效，之后必须重新登录授权。已经签发的 access token
                最长可能继续有效 1 小时。
              </AlertDialogDescription>
              <div class="dialog-actions">
                <AlertDialogCancel as-child>
                  <button class="secondary-button focus-ring" type="button">
                    取消
                  </button>
                </AlertDialogCancel>
                <AlertDialogAction as-child>
                  <button
                    class="danger-button focus-ring"
                    type="button"
                    :disabled="Boolean(revokingClientId)"
                    @click="revokeApplication(application)"
                  >
                    <Trash2 :size="18" aria-hidden="true" />
                    确认撤销
                  </button>
                </AlertDialogAction>
              </div>
            </AlertDialogContent>
          </AlertDialogPortal>
        </AlertDialogRoot>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.authorized-applications {
  display: grid;
  gap: var(--spacing-6);
  padding-block: clamp(var(--spacing-10), 8vw, var(--spacing-16));
}

.page-header,
.application-card,
.application-title-row,
.dialog-actions {
  display: flex;
  gap: var(--spacing-4);
  align-items: center;
  justify-content: space-between;
}

.eyebrow,
.dialog-eyebrow {
  margin: 0 0 var(--spacing-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

h1,
h2,
.dialog-title {
  margin: 0;
  font-family: var(--font-display);
  font-weight: var(--font-weight-bold);
}

h1 {
  font-size: clamp(var(--text-4xl), 9vw, 5.5rem);
  letter-spacing: var(--tracking-tight);
  line-height: 0.95;
}

h2 {
  font-size: var(--text-xl);
}

.page-copy,
.dialog-description {
  max-width: 48rem;
  margin: 0;
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.feedback,
.state-card,
.application-card {
  border: var(--border-width-control) solid var(--border-default);
}

.feedback {
  padding: var(--spacing-3) var(--spacing-4);
  margin: 0;
  font-weight: var(--font-weight-bold);
}

.feedback-error {
  border-color: var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.feedback-success {
  border-color: var(--status-success-border);
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}

.state-card {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  min-height: 6rem;
  padding: var(--spacing-4);
  background: var(--surface-elevated);
  font-family: var(--font-mono);
}

.state-card p {
  margin: 0;
}

.error-state {
  justify-content: space-between;
}

.loading-mark {
  width: var(--spacing-3);
  height: var(--spacing-3);
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--status-warning-bg);
  animation: pulse 1s steps(2, end) infinite;
}

.application-list {
  display: grid;
  gap: var(--spacing-4);
  padding: 0;
  margin: 0;
  list-style: none;
}

.application-card {
  padding: clamp(var(--spacing-4), 4vw, var(--spacing-6));
  background: var(--surface-panel);
  box-shadow: var(--shadow-hard-sm);
}

.application-icon {
  display: grid;
  flex: none;
  width: 3.25rem;
  height: 3.25rem;
  border: var(--border-width-control) solid var(--border-default);
  background: var(--accent-soft);
  place-items: center;
}

.application-summary {
  flex: 1;
  min-width: 0;
}

.application-title-row {
  justify-content: flex-start;
}

code,
.authorization-time,
.offline-status {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

code {
  display: block;
  margin-top: var(--spacing-1);
  color: var(--text-muted);
}

.authorization-time,
.offline-status {
  margin: var(--spacing-2) 0 0;
  color: var(--text-secondary);
}

.status-badge,
.scope-list li {
  padding: var(--spacing-1) var(--spacing-2);
  border: var(--border-width-thin) solid var(--border-default);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
}

.status-active {
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}

.status-inactive {
  background: var(--surface-muted);
  color: var(--text-secondary);
}

.scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
  padding: 0;
  margin: var(--spacing-3) 0 0;
  list-style: none;
}

.scope-list li {
  background: var(--surface-subtle);
  font-weight: normal;
}

.secondary-button,
.revoke-button,
.danger-button {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-weight: var(--font-weight-bold);
}

.secondary-button,
.revoke-button {
  background: var(--surface-panel);
}

.secondary-button:hover,
.revoke-button:hover {
  background: var(--app-highlighted);
}

.danger-button {
  border-color: var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.danger-button:hover {
  background: var(--app-danger-hover);
}

.danger-button:active {
  background: var(--app-danger-active);
}

.secondary-button:disabled,
.revoke-button:disabled,
.danger-button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.dialog-overlay {
  position: fixed;
  z-index: var(--z-overlay);
  inset: 0;
  background: var(--app-backdrop);
}

.dialog-content {
  position: fixed;
  z-index: var(--z-modal);
  top: 50%;
  left: 50%;
  width: min(calc(100% - 2 * var(--spacing-4)), 34rem);
  max-height: calc(100dvh - 2 * var(--spacing-4));
  padding: clamp(var(--spacing-5), 6vw, var(--spacing-8));
  overflow-y: auto;
  overscroll-behavior: contain;
  border: var(--border-width-surface) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
  transform: translate(-50%, -50%);
}

.dialog-title {
  font-size: clamp(var(--text-xl), 5vw, var(--text-3xl));
  line-height: var(--leading-tight);
}

.dialog-description {
  margin-block: var(--spacing-4) var(--spacing-6);
}

.dialog-actions {
  justify-content: flex-end;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

@media (width < 42rem) {
  .application-card {
    display: grid;
    grid-template-columns: auto 1fr;
  }

  .revoke-button {
    grid-column: 1 / -1;
    width: 100%;
  }

  .dialog-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-mark {
    animation: none;
  }
}
</style>

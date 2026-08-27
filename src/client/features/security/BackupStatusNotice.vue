<script setup lang="ts">
import { backupStatusService } from "@client/features/security/backup-status-service"
import { requiresAuthentication } from "@client/lib/auth-errors"
import { LogIn, RefreshCw, TriangleAlert } from "@lucide/vue"
import { computed, onMounted, onUnmounted, shallowRef } from "vue"
import { useRouter } from "vue-router"

type NoticeState =
  | Readonly<{ kind: "hidden" }>
  | Readonly<{
      kind: "backup-failed"
      lastAttemptAt: number
      refreshFailed: boolean
    }>
  | Readonly<{ kind: "authentication-required" }>
  | Readonly<{ kind: "unavailable" }>

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  hourCycle: "h23",
  timeStyle: "medium",
  timeZone: "Asia/Shanghai",
})

const router = useRouter()
const noticeState = shallowRef<NoticeState>({ kind: "hidden" })
const isLoading = shallowRef(false)
const minimumForegroundRevalidationInterval = 5 * 60 * 1000
let lastCheckedAt = 0
let isMounted = false
let scheduledRevalidationId: number | undefined

const failedAttemptDateTime = computed(() => {
  if (noticeState.value.kind !== "backup-failed") return undefined

  return new Date(noticeState.value.lastAttemptAt)
})

const failedAttemptLabel = computed(() => {
  if (failedAttemptDateTime.value === undefined) return ""

  return shanghaiDateTimeFormatter.format(failedAttemptDateTime.value)
})

const retryLabel = computed(() => {
  if (isLoading.value) return "检查中"
  return noticeState.value.kind === "backup-failed" ? "重新检查" : "重试"
})

function clearScheduledRevalidation(): void {
  if (scheduledRevalidationId === undefined) return

  window.clearTimeout(scheduledRevalidationId)
  scheduledRevalidationId = undefined
}

function scheduleFailedStatusRevalidation(): void {
  clearScheduledRevalidation()

  if (
    !isMounted ||
    isLoading.value ||
    noticeState.value.kind !== "backup-failed" ||
    document.visibilityState !== "visible"
  ) {
    return
  }

  const elapsed = Math.max(0, Date.now() - lastCheckedAt)
  const delay = Math.max(0, minimumForegroundRevalidationInterval - elapsed)

  scheduledRevalidationId = window.setTimeout(() => {
    scheduledRevalidationId = undefined

    if (
      document.visibilityState === "visible" &&
      noticeState.value.kind === "backup-failed"
    ) {
      void loadBackupStatus()
    }
  }, delay)
}

async function loadBackupStatus(): Promise<void> {
  if (isLoading.value) return

  clearScheduledRevalidation()
  isLoading.value = true

  try {
    const status = await backupStatusService.get()

    noticeState.value =
      status.status === "failed"
        ? {
            kind: "backup-failed",
            lastAttemptAt: status.lastAttemptAt,
            refreshFailed: false,
          }
        : { kind: "hidden" }
  } catch (error) {
    if (requiresAuthentication(error)) {
      noticeState.value = { kind: "authentication-required" }
    } else if (noticeState.value.kind === "backup-failed") {
      noticeState.value = {
        ...noticeState.value,
        refreshFailed: true,
      }
    } else {
      noticeState.value = { kind: "unavailable" }
    }
  } finally {
    lastCheckedAt = Date.now()
    isLoading.value = false
    scheduleFailedStatusRevalidation()
  }
}

function revalidateAfterForegroundReturn(): void {
  if (document.visibilityState !== "visible") return
  if (Date.now() - lastCheckedAt < minimumForegroundRevalidationInterval) {
    scheduleFailedStatusRevalidation()
    return
  }

  void loadBackupStatus()
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    revalidateAfterForegroundReturn()
  } else {
    clearScheduledRevalidation()
  }
}

async function returnToLogin(): Promise<void> {
  await router.replace("/login")
}

onMounted(() => {
  isMounted = true
  window.addEventListener("focus", revalidateAfterForegroundReturn)
  document.addEventListener("visibilitychange", handleVisibilityChange)
  void loadBackupStatus()
})

onUnmounted(() => {
  isMounted = false
  clearScheduledRevalidation()
  window.removeEventListener("focus", revalidateAfterForegroundReturn)
  document.removeEventListener("visibilitychange", handleVisibilityChange)
})
</script>

<template>
  <section
    v-if="noticeState.kind !== 'hidden'"
    class="backup-status-notice"
    :class="`backup-status-notice--${noticeState.kind}`"
    role="alert"
    aria-labelledby="backup-status-title"
  >
    <TriangleAlert :size="24" stroke-width="2.5" aria-hidden="true" />
    <div class="backup-status-content">
      <template v-if="noticeState.kind === 'backup-failed'">
        <h2 id="backup-status-title">数据库备份失败</h2>
        <p>
          数据库备份处于失败状态。最近一次尝试：
          <time :datetime="failedAttemptDateTime?.toISOString()">
            {{ failedAttemptLabel }}（Asia/Shanghai）
          </time>
          。请检查 Cloudflare Workers 日志。
        </p>
        <p v-if="noticeState.refreshFailed">
          最近一次状态检查失败；仍保留最近确认的备份失败状态，请稍后重试。
        </p>
      </template>
      <template v-else-if="noticeState.kind === 'authentication-required'">
        <h2 id="backup-status-title">需要重新登录</h2>
        <p>当前登录状态已失效，重新登录后才能确认数据库备份状态。</p>
      </template>
      <template v-else>
        <h2 id="backup-status-title">无法确认备份状态</h2>
        <p>备份状态暂时不可用，请检查网络后重试。</p>
      </template>
    </div>
    <button
      v-if="noticeState.kind === 'authentication-required'"
      class="backup-status-action focus-ring"
      type="button"
      @click="returnToLogin"
    >
      <LogIn :size="18" aria-hidden="true" />
      重新登录
    </button>
    <button
      v-else
      class="backup-status-action focus-ring"
      type="button"
      :disabled="isLoading"
      @click="loadBackupStatus"
    >
      <RefreshCw :size="18" aria-hidden="true" />
      {{ retryLabel }}
    </button>
  </section>
</template>

<style scoped>
.backup-status-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--spacing-3);
  align-items: center;
  width: min(100% - 2rem, 76rem);
  padding: var(--spacing-3) var(--spacing-4);
  margin: var(--spacing-4) auto 0;
  border: var(--border-width-control) solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}

.backup-status-notice--backup-failed {
  border-color: var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.backup-status-content {
  display: grid;
  gap: var(--spacing-1);
}

h2,
p {
  margin: 0;
}

h2 {
  font-family: var(--font-display);
  font-size: var(--text-base);
}

p {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.backup-status-action {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-3);
  border: var(--border-width-control) solid currentcolor;
  background: var(--surface-panel);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-weight: var(--font-weight-bold);
}

.backup-status-action:disabled {
  cursor: wait;
  opacity: 0.6;
}

@media (width < 40rem) {
  .backup-status-notice {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .backup-status-action {
    grid-column: 1 / -1;
    width: 100%;
  }
}
</style>

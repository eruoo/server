<script setup lang="ts">
import AppShell from "@client/components/layout/AppShell.vue"
import ApiKeyPanel from "@client/features/security/ApiKeyPanel.vue"
import PasskeyPanel from "@client/features/security/PasskeyPanel.vue"
import { authClient } from "@client/lib/auth-client"
import { computed } from "vue"
import { RouterLink } from "vue-router"

const session = authClient.useSession()
const sessionStatus = computed(() => {
  if (session.value.isPending) return "pending"
  if (session.value.error) return "unavailable"
  return session.value.data ? "success" : "error"
})

async function retrySession(): Promise<void> {
  try {
    await session.value.refetch()
  } catch {
    // Better Auth keeps the existing error state available for another retry.
  }
}
</script>

<template>
  <AppShell>
    <section class="workspace" aria-labelledby="workspace-title">
      <p class="eyebrow">OWNER CONSOLE</p>
      <h1 id="workspace-title" data-route-heading tabindex="-1">
        身份与访问状态
      </h1>
      <p class="workspace-copy">
        管理 Passkey、API
        Key、应用授权和安全审计。服务端权限检查始终是最终安全边界。
      </p>
      <div class="status-row" role="status">
        <span
          class="status-mark"
          :class="`status-mark-${sessionStatus}`"
          aria-hidden="true"
        ></span>
        <span v-if="session.isPending">正在验证 Session</span>
        <span v-else-if="session.error">Session 验证暂时不可用</span>
        <span v-else-if="session.data">
          已验证 · {{ session.data.user.name }}
        </span>
        <span v-else>Session 已失效</span>
      </div>
    </section>

    <div v-if="session.data && !session.error" class="security-grid">
      <PasskeyPanel />
      <ApiKeyPanel />
    </div>

    <section
      v-else-if="!session.isPending && session.error"
      class="session-recovery session-recovery-unavailable"
      aria-labelledby="session-unavailable-title"
      role="alert"
    >
      <h2 id="session-unavailable-title">暂时无法验证 Session</h2>
      <p>服务或网络暂时不可用，没有将你视为退出登录。请稍后重试。</p>
      <button
        class="recovery-link pressable focus-ring"
        type="button"
        :disabled="session.isRefetching"
        @click="retrySession"
      >
        {{ session.isRefetching ? "重试中" : "重试" }}
      </button>
    </section>

    <section
      v-else-if="!session.isPending"
      class="session-recovery"
      aria-labelledby="session-recovery-title"
      role="alert"
    >
      <h2 id="session-recovery-title">管理功能已暂停</h2>
      <p>当前 Session 无法验证。重新登录后才能继续管理长期凭证。</p>
      <RouterLink class="recovery-link pressable focus-ring" to="/login">
        重新登录
      </RouterLink>
    </section>
  </AppShell>
</template>

<style scoped>
.workspace {
  max-width: 58rem;
  padding-block: clamp(3rem, 10vw, 7rem);
}

.eyebrow {
  margin: 0 0 var(--spacing-3);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

h1 {
  max-width: 12ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2.75rem, 9vw, 6.5rem);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-tight);
  line-height: 0.92;
}

.workspace-copy {
  max-width: 42rem;
  margin-block: var(--spacing-8);
  color: var(--text-secondary);
  font-size: var(--text-lg);
  line-height: var(--leading-relaxed);
}

.status-row {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  width: fit-content;
  padding: var(--spacing-3) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-hard-sm);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.status-mark {
  width: var(--spacing-3);
  height: var(--spacing-3);
  border: var(--border-width-thin) solid var(--border-default);
}

.status-mark-pending {
  background: var(--status-warning-bg);
}

.status-mark-success {
  background: var(--status-success-bg);
}

.status-mark-error {
  background: var(--status-danger-bg);
}

.status-mark-unavailable {
  background: var(--status-warning-bg);
}

.security-grid {
  display: grid;
  gap: clamp(var(--spacing-8), 7vw, var(--spacing-16));
  padding-block-end: clamp(var(--spacing-12), 10vw, var(--spacing-20));
}

.session-recovery {
  display: grid;
  gap: var(--spacing-4);
  max-width: 42rem;
  padding: clamp(var(--spacing-5), 5vw, var(--spacing-8));
  margin-block-end: clamp(var(--spacing-12), 10vw, var(--spacing-20));
  border: var(--border-width-surface) solid var(--status-danger-border);
  background: var(--status-danger-bg);
  box-shadow: var(--shadow-panel);
  color: var(--status-danger-fg);
}

.session-recovery h2,
.session-recovery p {
  margin: 0;
}

.session-recovery h2 {
  font-family: var(--font-display);
  font-size: var(--text-2xl);
}

.session-recovery-unavailable {
  border-color: var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}

.session-recovery p {
  line-height: var(--leading-relaxed);
}

.recovery-link {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-hard-sm);
  color: var(--text-primary);
  font-weight: var(--font-weight-bold);
  text-decoration: none;
}

.recovery-link:disabled {
  cursor: wait;
  opacity: 0.6;
}
</style>

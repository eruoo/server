<script setup lang="ts">
import { Fingerprint, GitBranch } from "@lucide/vue"

const props = defineProps<{
  disabled?: boolean
  pendingMethod?: "github" | "passkey" | undefined
}>()

const emit = defineEmits<{
  github: []
  passkey: []
}>()
</script>

<template>
  <section
    class="login-panel"
    aria-labelledby="login-title"
    :aria-busy="Boolean(props.pendingMethod)"
  >
    <p class="eyebrow">ERUOO SECURITY</p>
    <h1 id="login-title" data-route-heading tabindex="-1">确认 owner 身份</h1>
    <p class="intro">GitHub 用于首次引导和恢复；Passkey 是日常登录方式。</p>
    <div class="actions">
      <button
        class="primary pressable focus-ring"
        :disabled="props.disabled"
        :aria-busy="props.pendingMethod === 'passkey'"
        type="button"
        @click="emit('passkey')"
      >
        <Fingerprint :size="20" aria-hidden="true" />
        {{
          props.pendingMethod === "passkey"
            ? "正在验证 Passkey…"
            : "使用 Passkey"
        }}
      </button>
      <button
        class="secondary pressable focus-ring"
        :disabled="props.disabled"
        :aria-busy="props.pendingMethod === 'github'"
        type="button"
        @click="emit('github')"
      >
        <GitBranch :size="20" aria-hidden="true" />
        {{
          props.pendingMethod === "github" ? "正在前往 GitHub…" : "使用 GitHub"
        }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.login-panel {
  width: min(100%, 36rem);
  padding: clamp(var(--spacing-6), 7vw, var(--spacing-10));
  border: var(--border-width-surface) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
}

.eyebrow {
  margin: 0 0 var(--spacing-4);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(var(--text-3xl), 8vw, var(--text-5xl));
  line-height: var(--leading-tight);
}

.intro {
  margin-block: var(--spacing-5) var(--spacing-8);
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.actions {
  display: grid;
  gap: var(--spacing-4);
}

button {
  display: inline-flex;
  gap: var(--spacing-3);
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-3) var(--spacing-5);
  border: var(--border-width-control) solid var(--border-default);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-weight: var(--font-weight-bold);
}

button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.primary {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  box-shadow: var(--shadow-hard-sm);
}

.primary:hover {
  background: var(--accent-primary-hover);
  color: var(--accent-contrast-hover);
}

.primary:active {
  background: var(--accent-primary-active);
  color: var(--accent-contrast-active);
}

.secondary {
  background: var(--surface-elevated);
}
</style>

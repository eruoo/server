<script setup lang="ts">
import { authClient } from "@client/lib/auth-client"
import { Fingerprint, GitBranch, ShieldAlert } from "@lucide/vue"
import { ref } from "vue"

defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  verified: []
}>()

const isPending = ref(false)
const errorMessage = ref<string | undefined>()

function githubReauthenticationCallbackLocation(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete("error")
  url.searchParams.delete("error_description")
  url.searchParams.set("reauthentication", "github")

  return `${url.pathname}${url.search}`
}

async function reauthenticateWithPasskey() {
  if (isPending.value) return

  errorMessage.value = undefined
  isPending.value = true

  try {
    const result = await authClient.signIn.passkey()

    if (result.error) {
      errorMessage.value = "Passkey 验证未完成，请重试或使用 GitHub。"
      return
    }

    emit("verified")
  } catch {
    errorMessage.value = "Passkey 验证暂时不可用，请检查网络后重试。"
  } finally {
    isPending.value = false
  }
}

async function reauthenticateWithGitHub() {
  if (isPending.value) return

  errorMessage.value = undefined
  isPending.value = true

  try {
    const callbackURL = githubReauthenticationCallbackLocation()
    const result = await authClient.signIn.social({
      callbackURL,
      errorCallbackURL: callbackURL,
      provider: "github",
    })

    if (result.error) {
      errorMessage.value = "GitHub 验证未完成，请重试。"
    }
  } catch {
    errorMessage.value = "GitHub 验证暂时不可用，请检查网络后重试。"
  } finally {
    isPending.value = false
  }
}
</script>

<template>
  <section v-if="visible" class="reauth-notice" aria-labelledby="reauth-title">
    <div class="reauth-heading">
      <ShieldAlert :size="24" aria-hidden="true" />
      <h3 id="reauth-title">需要重新确认身份</h3>
    </div>
    <p>最近一次身份确认已超过 15 分钟。完成验证后，请再次执行刚才的操作。</p>
    <div class="reauth-actions">
      <button
        class="reauth-primary focus-ring"
        type="button"
        :disabled="isPending"
        @click="reauthenticateWithPasskey"
      >
        <Fingerprint :size="18" aria-hidden="true" />
        使用 Passkey
      </button>
      <button
        class="reauth-secondary focus-ring"
        type="button"
        :disabled="isPending"
        @click="reauthenticateWithGitHub"
      >
        <GitBranch :size="18" aria-hidden="true" />
        使用 GitHub
      </button>
    </div>
    <p v-if="errorMessage" class="reauth-error" role="alert">
      {{ errorMessage }}
    </p>
  </section>
</template>

<style scoped>
.reauth-notice {
  display: grid;
  gap: var(--spacing-4);
  padding: var(--spacing-4);
  border: var(--border-width-control) solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}

.reauth-heading,
.reauth-actions,
button {
  display: flex;
  align-items: center;
}

.reauth-heading,
.reauth-actions {
  gap: var(--spacing-3);
}

h3,
p {
  margin: 0;
}

h3 {
  font-family: var(--font-display);
  font-size: var(--text-xl);
}

.reauth-actions {
  flex-wrap: wrap;
}

button {
  gap: var(--spacing-2);
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-weight: var(--font-weight-bold);
}

button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.reauth-primary {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  box-shadow: var(--shadow-hard-sm);
}

.reauth-secondary {
  background: var(--surface-panel);
}

.reauth-error {
  padding: var(--spacing-3);
  border: var(--border-width-thin) solid var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

@media (width < 30rem) {
  .reauth-actions {
    display: grid;
  }
}
</style>

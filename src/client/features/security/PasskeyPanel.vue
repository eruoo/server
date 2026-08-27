<script setup lang="ts">
import RecentAuthenticationNotice from "@client/features/auth/RecentAuthenticationNotice.vue"
import { authClient } from "@client/lib/auth-client"
import { requiresRecentAuthentication } from "@client/lib/auth-errors"
import { Fingerprint, Plus, Trash2 } from "@lucide/vue"
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
import { computed, shallowRef, watch } from "vue"
import { RouterLink } from "vue-router"

interface Feedback {
  kind: "error" | "success"
  message: string
}

const passkeyQuery = authClient.useListPasskeys()
const passkeyName = shallowRef("")
const isAdding = shallowRef(false)
const deletingPasskeyId = shallowRef<string | null>(null)
const feedback = shallowRef<Feedback | null>(null)
const needsRecentAuthentication = shallowRef(false)
const authenticationRequired = shallowRef(false)

const passkeys = computed(() =>
  (passkeyQuery.value.data ?? []).map((passkey) => ({
    id: passkey.id,
    name: passkey.name?.trim() || "未命名 Passkey",
    deviceLabel:
      passkey.deviceType === "multiDevice" ? "多设备凭据" : "单设备凭据",
    backupLabel: passkey.backedUp ? "已备份" : "未备份",
  })),
)
const hasLoadError = computed(() => Boolean(passkeyQuery.value.error))
const isBusy = computed(
  () => isAdding.value || deletingPasskeyId.value !== null,
)

function showAuthenticationRequired(): void {
  authenticationRequired.value = true
  needsRecentAuthentication.value = false
  feedback.value = null
}

async function sessionIsUnavailable(): Promise<boolean> {
  try {
    const result = await authClient.getSession()
    return result.error == null && result.data === null
  } catch {
    return false
  }
}

async function reportOperationError(error: unknown, fallback: string) {
  if (await sessionIsUnavailable()) {
    showAuthenticationRequired()
    return
  }

  if (requiresRecentAuthentication(error)) {
    needsRecentAuthentication.value = true
    feedback.value = {
      kind: "error",
      message: "请先重新确认身份，再执行这项操作。",
    }
    return
  }

  feedback.value = {
    kind: "error",
    message: fallback,
  }
}

function handleReauthenticated() {
  needsRecentAuthentication.value = false
  feedback.value = {
    kind: "success",
    message: "身份已重新确认，请再次执行刚才的操作。",
  }
}

async function refreshPasskeys() {
  try {
    await passkeyQuery.value.refetch()
  } catch {
    if (await sessionIsUnavailable()) {
      showAuthenticationRequired()
      return
    }

    feedback.value = {
      kind: "error",
      message: "操作已完成，但 Passkey 列表刷新失败。",
    }
  }
}

async function retryPasskeyList() {
  try {
    await passkeyQuery.value.refetch()
  } catch {
    if (await sessionIsUnavailable()) showAuthenticationRequired()
  }
}

async function addPasskey() {
  if (isBusy.value) return

  feedback.value = null
  isAdding.value = true

  try {
    const name = passkeyName.value.trim()
    const result = await authClient.passkey.addPasskey(name ? { name } : {})

    if (result.error) {
      await reportOperationError(result.error, "Passkey 添加失败。")
      return
    }

    passkeyName.value = ""
    feedback.value = { kind: "success", message: "Passkey 已添加。" }
    await refreshPasskeys()
  } catch (error) {
    await reportOperationError(error, "Passkey 添加失败。")
  } finally {
    isAdding.value = false
  }
}

async function deletePasskey(id: string) {
  if (isBusy.value) return

  feedback.value = null
  deletingPasskeyId.value = id

  try {
    const result = await authClient.passkey.deletePasskey({ id })

    if (result.error) {
      await reportOperationError(result.error, "Passkey 删除失败。")
      return
    }

    feedback.value = { kind: "success", message: "Passkey 已删除。" }
    await refreshPasskeys()
  } catch (error) {
    await reportOperationError(error, "Passkey 删除失败。")
  } finally {
    deletingPasskeyId.value = null
  }
}

watch(
  () => passkeyQuery.value.error,
  async (error, _previousError, onCleanup) => {
    if (!error) return

    let isCurrent = true
    onCleanup(() => {
      isCurrent = false
    })

    if ((await sessionIsUnavailable()) && isCurrent) {
      showAuthenticationRequired()
    }
  },
  { immediate: true },
)
</script>

<template>
  <section
    class="passkey-panel"
    aria-labelledby="passkey-panel-title"
    :aria-busy="passkeyQuery.isPending || isBusy"
  >
    <header class="panel-header">
      <div class="title-group">
        <span class="title-icon" aria-hidden="true">
          <Fingerprint :size="24" />
        </span>
        <div>
          <p class="eyebrow">PASSWORDLESS</p>
          <h2 id="passkey-panel-title" class="panel-title">Passkey</h2>
        </div>
      </div>
      <span class="count-badge" aria-label="Passkey 数量">
        {{ passkeys.length }}
      </span>
    </header>

    <p class="panel-copy">
      使用设备生物识别或系统解锁完成登录。建议至少注册两个可独立恢复的 Passkey。
    </p>

    <RecentAuthenticationNotice
      :visible="needsRecentAuthentication"
      @verified="handleReauthenticated"
    />

    <form
      v-if="!authenticationRequired"
      class="add-form"
      @submit.prevent="addPasskey"
    >
      <div class="field-group">
        <label class="field-label" for="passkey-name">凭据名称</label>
        <input
          id="passkey-name"
          v-model="passkeyName"
          class="text-input focus-ring"
          name="passkey-name"
          type="text"
          maxlength="64"
          autocomplete="off"
          enterkeyhint="done"
          aria-describedby="passkey-name-help"
          :disabled="isBusy"
          placeholder="例如：MacBook Touch ID"
        />
        <span id="passkey-name-help" class="field-help">
          名称仅用于区分设备，可以留空。
        </span>
      </div>
      <button
        class="button primary-button pressable focus-ring"
        type="submit"
        :disabled="isBusy"
      >
        <Plus :size="18" aria-hidden="true" />
        {{ isAdding ? "等待设备确认…" : "添加 Passkey" }}
      </button>
    </form>

    <p
      v-if="feedback"
      class="feedback"
      :class="`feedback-${feedback.kind}`"
      :role="feedback.kind === 'error' ? 'alert' : 'status'"
      aria-live="polite"
    >
      {{ feedback.message }}
    </p>

    <div
      v-if="authenticationRequired"
      class="list-state error-state"
      role="alert"
    >
      <div>
        <strong>Session 已失效。</strong>
        <p>重新登录后才能继续管理 Passkey。</p>
      </div>
      <RouterLink class="text-button focus-ring" to="/login">
        重新登录
      </RouterLink>
    </div>

    <div v-else-if="passkeyQuery.isPending" class="list-state" role="status">
      正在载入 Passkey…
    </div>

    <div v-else-if="hasLoadError" class="list-state error-state" role="alert">
      <span>无法读取 Passkey 列表，请稍后重试。</span>
      <button
        class="text-button focus-ring"
        type="button"
        :disabled="passkeyQuery.isRefetching"
        @click="retryPasskeyList"
      >
        {{ passkeyQuery.isRefetching ? "重试中…" : "重新载入" }}
      </button>
    </div>

    <p v-else-if="passkeys.length === 0" class="list-state">
      尚未注册 Passkey。
    </p>

    <ul v-else class="passkey-list" aria-label="已注册的 Passkey">
      <li v-for="passkey in passkeys" :key="passkey.id" class="passkey-item">
        <div class="passkey-details">
          <strong class="passkey-name">{{ passkey.name }}</strong>
          <span class="passkey-meta">
            {{ passkey.deviceLabel }} · {{ passkey.backupLabel }}
          </span>
        </div>

        <AlertDialogRoot>
          <AlertDialogTrigger
            class="icon-button danger-trigger focus-ring"
            type="button"
            :disabled="isBusy"
            :aria-label="`删除 ${passkey.name}`"
          >
            <Trash2 :size="18" aria-hidden="true" />
          </AlertDialogTrigger>

          <AlertDialogPortal>
            <AlertDialogOverlay class="dialog-overlay" />
            <AlertDialogContent class="dialog-content">
              <AlertDialogTitle class="dialog-title">
                删除 {{ passkey.name }}？
              </AlertDialogTitle>
              <AlertDialogDescription class="dialog-description">
                删除后，这个凭据将无法再用于登录。设备中保存的凭据可能仍需在系统设置中单独移除。
              </AlertDialogDescription>
              <div class="dialog-actions">
                <AlertDialogCancel
                  class="button secondary-button focus-ring"
                  type="button"
                >
                  取消
                </AlertDialogCancel>
                <AlertDialogAction
                  class="button danger-button focus-ring"
                  type="button"
                  @click="deletePasskey(passkey.id)"
                >
                  确认删除
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
.passkey-panel {
  padding: clamp(var(--spacing-5), 5vw, var(--spacing-8));
  border: var(--border-width-surface) solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
}

.panel-header,
.title-group,
.add-form,
.passkey-item,
.dialog-actions {
  display: flex;
  align-items: center;
}

.panel-header,
.passkey-item {
  justify-content: space-between;
}

.panel-header {
  gap: var(--spacing-4);
}

.title-group {
  gap: var(--spacing-3);
}

.title-icon,
.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: var(--border-width-control) solid var(--border-default);
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.title-icon {
  width: var(--size-control-lg);
  height: var(--size-control-lg);
  box-shadow: var(--shadow-hard-sm);
}

.count-badge {
  min-width: var(--touch-target-min);
  min-height: var(--touch-target-min);
  padding-inline: var(--spacing-3);
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
}

.eyebrow {
  margin: 0 0 var(--spacing-1);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

.panel-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(var(--text-2xl), 7vw, var(--text-4xl));
  line-height: var(--leading-none);
}

.panel-copy {
  max-width: 48rem;
  margin-block: var(--spacing-6);
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.add-form {
  gap: var(--spacing-4);
  align-items: flex-end;
  padding: var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-elevated);
}

.field-group {
  display: grid;
  flex: 1;
  gap: var(--spacing-2);
  min-width: 0;
}

.field-label {
  font-weight: var(--font-weight-bold);
}

.field-help,
.passkey-meta {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.text-input {
  width: 100%;
  min-height: var(--touch-target-min);
  padding: var(--spacing-3);
  border: var(--border-width-control) solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--surface-panel);
  color: var(--text-primary);
  font: inherit;
}

.text-input::placeholder {
  color: var(--text-muted);
  opacity: 1;
}

.button,
.icon-button,
.text-button {
  border: var(--border-width-control) solid var(--border-default);
  border-radius: var(--radius-control);
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-weight: var(--font-weight-bold);
}

.button {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-3) var(--spacing-4);
}

.primary-button {
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.primary-button:hover {
  background: var(--accent-primary-hover);
  color: var(--accent-contrast-hover);
}

.primary-button:active {
  background: var(--accent-primary-active);
  color: var(--accent-contrast-active);
}

.button:disabled,
.icon-button:disabled,
.text-button:disabled,
.text-input:disabled {
  cursor: wait;
  opacity: var(--opacity-disabled);
}

.feedback,
.list-state {
  margin: var(--spacing-4) 0 0;
  padding: var(--spacing-3) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.feedback-success {
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}

.feedback-error,
.error-state {
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.error-state {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  justify-content: space-between;
}

.text-button {
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target-min);
  padding-inline: var(--spacing-3);
  background: var(--surface-panel);
  text-decoration: none;
}

.passkey-list {
  display: grid;
  gap: var(--spacing-3);
  margin: var(--spacing-5) 0 0;
  padding: 0;
  list-style: none;
}

.passkey-item {
  gap: var(--spacing-4);
  padding: var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-subtle);
  box-shadow: var(--shadow-hard-sm);
}

.passkey-details {
  display: grid;
  gap: var(--spacing-1);
  min-width: 0;
}

.passkey-name {
  overflow-wrap: anywhere;
}

.icon-button {
  display: inline-grid;
  flex: 0 0 auto;
  width: var(--touch-target-min);
  height: var(--touch-target-min);
  place-items: center;
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.danger-trigger:hover,
.danger-button:hover {
  background: var(--app-danger-hover);
}

.danger-trigger:active,
.danger-button:active {
  background: var(--app-danger-active);
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
  width: min(calc(100vw - 2 * var(--spacing-5)), 32rem);
  max-height: calc(100vh - 2 * var(--spacing-5));
  padding: clamp(var(--spacing-5), 6vw, var(--spacing-8));
  overflow-y: auto;
  overscroll-behavior: contain;
  border: var(--border-width-surface) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
  translate: -50% -50%;
}

.dialog-title {
  display: block;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-2xl);
  font-weight: var(--font-weight-bold);
  line-height: var(--leading-tight);
}

.dialog-description {
  display: block;
  margin-block: var(--spacing-4) var(--spacing-6);
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.dialog-actions {
  gap: var(--spacing-3);
  justify-content: flex-end;
}

.secondary-button {
  background: var(--surface-elevated);
}

.danger-button {
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

@media (max-width: 40rem) {
  .add-form {
    align-items: stretch;
    flex-direction: column;
  }

  .primary-button,
  .dialog-actions .button {
    width: 100%;
  }

  .dialog-actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .dialog-overlay {
    animation: var(--animate-fade-in);
  }

  .dialog-content {
    animation: var(--animate-pop-in);
  }
}

@media (forced-colors: active) {
  .passkey-panel,
  .passkey-item,
  .dialog-content {
    border-color: CanvasText;
  }

  .dialog-overlay {
    background: rgb(0 0 0 / 0.75);
  }
}
</style>

<script setup lang="ts">
import RecentAuthenticationNotice from "@client/features/auth/RecentAuthenticationNotice.vue"
import { authClient } from "@client/lib/auth-client"
import { requiresRecentAuthentication } from "@client/lib/auth-errors"
import {
  nativeClipboardWritePending,
  startNativeClipboardWrite,
} from "@client/lib/native-clipboard-write"
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from "@lucide/vue"
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
import { RouterLink } from "vue-router"

type ApiKeyList = NonNullable<
  Awaited<ReturnType<typeof authClient.apiKey.list>>["data"]
>
type ListedApiKey = ApiKeyList["apiKeys"][number]
type CreatedApiKey = { id: string; key: string }
type CopyState = "copying" | "error" | "idle" | "success"
type Feedback = {
  alreadyAnnounced?: boolean
  kind: "error" | "success" | "warning"
  message: string
}

const apiKeys = shallowRef<ListedApiKey[]>([])
const loadState = shallowRef<
  "authentication-required" | "error" | "loading" | "ready"
>("loading")
const feedback = shallowRef<Feedback>()
const createdApiKey = shallowRef<CreatedApiKey>()
const createdApiKeyAnnouncement = shallowRef("")
const copyInFlight = shallowRef(false)
const copyState = shallowRef<CopyState>("idle")
const isCreating = shallowRef(false)
const newApiKeyName = shallowRef("")
const revokingId = shallowRef<string>()
const needsRecentAuthentication = shallowRef(false)
let copyAttemptGeneration = 0

function displayName(apiKey: ListedApiKey) {
  return apiKey.name?.trim() || "未命名密钥"
}

function keyHint(apiKey: ListedApiKey) {
  return apiKey.start ? `${apiKey.start}••••` : "未提供识别前缀"
}

function isExpired(apiKey: ListedApiKey) {
  const expiresAt = expirationTimestamp(apiKey)

  return expiresAt !== undefined && expiresAt <= Date.now()
}

function expirationTimestamp(apiKey: ListedApiKey) {
  if (!apiKey.expiresAt) return undefined

  const expiresAt =
    apiKey.expiresAt instanceof Date
      ? apiKey.expiresAt.getTime()
      : new Date(apiKey.expiresAt).getTime()

  return Number.isFinite(expiresAt) ? expiresAt : undefined
}

function expiryNotice(apiKey: ListedApiKey) {
  const expiresAt = expirationTimestamp(apiKey)
  if (expiresAt === undefined) return "到期时间不可用"

  const remainingDays = Math.ceil(
    (expiresAt - Date.now()) / (24 * 60 * 60 * 1000),
  )

  if (remainingDays <= 0) return "已到期"
  return `${remainingDays} 天后到期`
}

function isExpiringSoon(apiKey: ListedApiKey) {
  const expiresAt = expirationTimestamp(apiKey)
  if (expiresAt === undefined) return false

  const remaining = expiresAt - Date.now()
  return remaining > 0 && remaining <= 14 * 24 * 60 * 60 * 1000
}

function permissionLabels(apiKey: ListedApiKey) {
  if (
    !apiKey.permissions ||
    typeof apiKey.permissions !== "object" ||
    Array.isArray(apiKey.permissions)
  ) {
    return []
  }

  return Object.entries(apiKey.permissions).flatMap(([resource, actions]) =>
    Array.isArray(actions)
      ? actions
          .filter((action): action is string => typeof action === "string")
          .map((action) => `${resource}:${action}`)
      : [],
  )
}

function statusLabel(apiKey: ListedApiKey) {
  if (!apiKey.enabled) return "已停用"
  if (isExpired(apiKey)) return "已过期"
  return "有效"
}

function clearCreatedApiKey() {
  copyAttemptGeneration += 1
  createdApiKey.value = undefined
  createdApiKeyAnnouncement.value = ""
  copyInFlight.value = false
  copyState.value = "idle"
}

function selectCreatedApiKey(event: FocusEvent) {
  if (event.currentTarget instanceof HTMLInputElement) {
    event.currentTarget.select()
  }
}

async function copyCreatedApiKey() {
  const apiKey = createdApiKey.value
  if (!apiKey || copyInFlight.value || nativeClipboardWritePending.value) return

  const nativeWrite = startNativeClipboardWrite(apiKey.key)
  if (!nativeWrite) return

  const copyAttempt = ++copyAttemptGeneration
  copyInFlight.value = true
  copyState.value = "copying"

  try {
    await nativeWrite

    if (
      copyAttemptGeneration === copyAttempt &&
      createdApiKey.value === apiKey
    ) {
      copyState.value = "success"
    }
  } catch {
    if (
      copyAttemptGeneration === copyAttempt &&
      createdApiKey.value === apiKey
    ) {
      copyState.value = "error"
    }
  } finally {
    if (copyAttemptGeneration === copyAttempt) {
      copyInFlight.value = false
    }
  }
}

function preventOverlappingManualCopy(event: ClipboardEvent) {
  if (nativeClipboardWritePending.value) event.preventDefault()
}

function handleReauthenticated() {
  needsRecentAuthentication.value = false
  feedback.value = {
    kind: "success",
    message: "身份已重新确认，请再次执行刚才的操作。",
  }
}

function showAuthenticationRequired(): void {
  apiKeys.value = []
  loadState.value = "authentication-required"
  needsRecentAuthentication.value = false
  feedback.value = undefined
}

async function sessionIsUnavailable(): Promise<boolean> {
  try {
    const result = await authClient.getSession()
    return result.error == null && result.data === null
  } catch {
    return false
  }
}

async function reportRevokeError(apiKey: ListedApiKey, error: unknown) {
  if (await sessionIsUnavailable()) {
    showAuthenticationRequired()
    return
  }

  if (requiresRecentAuthentication(error)) {
    needsRecentAuthentication.value = true
    feedback.value = {
      kind: "error",
      message: "请先重新确认身份，再撤销这个 API Key。",
    }
    return
  }

  feedback.value = {
    kind: "error",
    message: `无法撤销“${displayName(apiKey)}”，请稍后重试。`,
  }
}

async function reportCreateError(error: unknown) {
  if (await sessionIsUnavailable()) {
    showAuthenticationRequired()
    return
  }

  if (requiresRecentAuthentication(error)) {
    needsRecentAuthentication.value = true
    feedback.value = {
      kind: "error",
      message: "请先重新确认身份，再创建 API Key。",
    }
    return
  }

  feedback.value = {
    kind: "error",
    message: "无法创建 API Key，请稍后重试。",
  }
}

async function loadApiKeys() {
  loadState.value = "loading"
  feedback.value = undefined

  try {
    const { data, error } = await authClient.apiKey.list()

    if (error || !data) {
      if (await sessionIsUnavailable()) {
        showAuthenticationRequired()
        return
      }

      loadState.value = "error"
      feedback.value = {
        kind: "error",
        message: "无法读取 API Key，请稍后重试。",
      }
      return
    }

    apiKeys.value = data.apiKeys
    loadState.value = "ready"
  } catch {
    if (await sessionIsUnavailable()) {
      showAuthenticationRequired()
      return
    }

    loadState.value = "error"
    feedback.value = {
      kind: "error",
      message: "无法读取 API Key，请检查网络后重试。",
    }
  }
}

async function revokeApiKey(apiKey: ListedApiKey) {
  if (revokingId.value) return

  revokingId.value = apiKey.id
  feedback.value = undefined

  try {
    const { error } = await authClient.apiKey.delete({ keyId: apiKey.id })

    if (error) {
      await reportRevokeError(apiKey, error)
      return
    }

    if (createdApiKey.value?.id === apiKey.id) {
      clearCreatedApiKey()
    }

    apiKeys.value = apiKeys.value.filter(({ id }) => id !== apiKey.id)
    feedback.value = {
      kind: "success",
      message: `已撤销“${displayName(apiKey)}”。`,
    }
  } catch (error) {
    await reportRevokeError(apiKey, error)
  } finally {
    revokingId.value = undefined
  }
}

async function createApiKey() {
  if (isCreating.value || copyInFlight.value) return

  const name = newApiKeyName.value.trim()
  if (!name) {
    feedback.value = {
      kind: "error",
      message: "请输入 API Key 名称。",
    }
    return
  }

  isCreating.value = true
  clearCreatedApiKey()
  feedback.value = undefined

  try {
    const { data, error } = await authClient.apiKey.create({
      expiresIn: 180 * 24 * 60 * 60,
      name,
    })

    if (error || !data?.key) {
      await reportCreateError(error)
      return
    }

    createdApiKey.value = { id: data.id, key: data.key }
    createdApiKeyAnnouncement.value =
      "API Key 已创建。完整密钥已显示，请立即保存。"
    newApiKeyName.value = ""
    await loadApiKeys()

    if (loadState.value === "ready") {
      feedback.value = {
        alreadyAnnounced: true,
        kind: "success",
        message: `已创建“${name}”。请立即保存下面的完整密钥。`,
      }
    } else if (loadState.value === "authentication-required") {
      feedback.value = {
        kind: "warning",
        message: `已创建“${name}”，但 Session 随后失效。请先保存下面的完整密钥，再重新登录。`,
      }
    } else {
      feedback.value = {
        kind: "warning",
        message: `已创建“${name}”，但列表暂时无法刷新。请先保存下面的完整密钥，再重试列表。`,
      }
    }
  } catch (error) {
    await reportCreateError(error)
  } finally {
    isCreating.value = false
  }
}

onMounted(loadApiKeys)
</script>

<template>
  <section class="api-key-panel" aria-labelledby="api-key-title">
    <header class="panel-header">
      <div>
        <p class="eyebrow">MACHINE ACCESS</p>
        <h2 id="api-key-title">API Keys</h2>
      </div>
      <KeyRound :size="30" stroke-width="2.25" aria-hidden="true" />
    </header>

    <p class="panel-copy">
      查看现有密钥并撤销不再使用的访问。完整密钥和哈希不会在这里显示。
    </p>

    <RecentAuthenticationNotice
      :visible="needsRecentAuthentication"
      @verified="handleReauthenticated"
    />

    <form class="create-form" @submit.prevent="createApiKey">
      <label for="api-key-name">新 API Key 名称</label>
      <div class="create-controls">
        <input
          id="api-key-name"
          v-model="newApiKeyName"
          class="key-name-input focus-ring"
          name="api-key-name"
          type="text"
          maxlength="32"
          autocomplete="off"
          required
          :disabled="isCreating || loadState === 'authentication-required'"
        />
        <button
          class="secondary-button focus-ring"
          type="submit"
          :disabled="isCreating || copyInFlight || loadState !== 'ready'"
        >
          <Plus :size="18" aria-hidden="true" />
          {{ isCreating ? "创建中" : copyInFlight ? "复制处理中" : "创建" }}
        </button>
      </div>
      <small>固定授予 status:read，有效期 180 天。</small>
    </form>

    <div v-if="createdApiKey" class="created-key">
      <label class="created-key-label" for="created-api-key">
        完整密钥只显示这一次
      </label>
      <div class="created-key-controls">
        <input
          id="created-api-key"
          class="created-key-value focus-ring"
          type="text"
          :value="createdApiKey.key"
          readonly
          autocomplete="off"
          spellcheck="false"
          :aria-describedby="
            nativeClipboardWritePending
              ? 'created-api-key-help created-api-key-copy-wait'
              : 'created-api-key-help'
          "
          :aria-disabled="nativeClipboardWritePending"
          @focus="selectCreatedApiKey"
          @copy="preventOverlappingManualCopy"
        />
        <button
          class="secondary-button focus-ring"
          type="button"
          :disabled="copyInFlight || nativeClipboardWritePending"
          :aria-busy="copyInFlight || nativeClipboardWritePending"
          :aria-label="
            copyInFlight
              ? '剪贴板写入处理中，请稍候'
              : nativeClipboardWritePending
                ? '等待上一次剪贴板写入完成'
                : '复制完整 API Key'
          "
          @click="copyCreatedApiKey"
        >
          <Copy :size="18" aria-hidden="true" />
          {{
            copyInFlight
              ? "处理中"
              : nativeClipboardWritePending
                ? "请稍候"
                : "复制"
          }}
        </button>
      </div>
      <p id="created-api-key-help">
        离开或刷新页面前，请把它保存到调用方的安全凭证存储。
      </p>
      <p
        v-if="nativeClipboardWritePending"
        id="created-api-key-copy-wait"
        class="copy-feedback"
        role="status"
      >
        {{
          copyInFlight
            ? "正在写入剪贴板，请稍候。"
            : "上一次剪贴板写入尚未完成，请稍后再复制。"
        }}
      </p>
      <p
        v-else-if="copyState === 'success'"
        class="copy-feedback"
        role="status"
      >
        已复制到剪贴板。
      </p>
      <p v-else-if="copyState === 'error'" class="copy-feedback" role="alert">
        自动复制失败，请手动选择并复制完整密钥。
      </p>
    </div>

    <p
      class="created-key-announcement"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ createdApiKeyAnnouncement }}
    </p>

    <p
      v-if="feedback"
      class="feedback"
      :class="`feedback-${feedback.kind}`"
      :role="
        feedback.alreadyAnnounced
          ? undefined
          : feedback.kind === 'success'
            ? 'status'
            : 'alert'
      "
      :aria-live="feedback.alreadyAnnounced ? undefined : 'polite'"
    >
      {{ feedback.message }}
    </p>

    <div v-if="loadState === 'loading'" class="state-card" role="status">
      <span class="loading-mark" aria-hidden="true"></span>
      正在读取 API Keys…
    </div>

    <div
      v-else-if="loadState === 'authentication-required'"
      class="state-card error-state"
      role="alert"
    >
      <div>
        <strong>Session 已失效。</strong>
        <p>重新登录后才能继续管理 API Key。</p>
      </div>
      <RouterLink class="secondary-button focus-ring" to="/login">
        重新登录
      </RouterLink>
    </div>

    <div v-else-if="loadState === 'error'" class="state-card error-state">
      <p>API Key 列表暂时不可用。</p>
      <button
        class="secondary-button focus-ring"
        type="button"
        @click="loadApiKeys"
      >
        <RefreshCw :size="18" aria-hidden="true" />
        重试
      </button>
    </div>

    <div v-else-if="apiKeys.length === 0" class="state-card empty-state">
      <p>还没有 API Key。</p>
      <small>可以创建一把仅用于读取服务状态的密钥。</small>
    </div>

    <ul v-else class="key-list" aria-label="现有 API Keys">
      <li v-for="apiKey in apiKeys" :key="apiKey.id" class="key-card">
        <div class="key-summary">
          <div class="key-name-row">
            <h3>{{ displayName(apiKey) }}</h3>
            <span
              class="status-badge"
              :class="{
                'status-active': apiKey.enabled && !isExpired(apiKey),
                'status-inactive': !apiKey.enabled || isExpired(apiKey),
              }"
            >
              {{ statusLabel(apiKey) }}
            </span>
          </div>
          <code>{{ keyHint(apiKey) }}</code>
          <p
            class="expiry"
            :class="{ 'expiry-warning': isExpiringSoon(apiKey) }"
          >
            {{ expiryNotice(apiKey) }}
          </p>
          <ul
            v-if="permissionLabels(apiKey).length > 0"
            class="permission-list"
            aria-label="权限"
          >
            <li
              v-for="permission in permissionLabels(apiKey)"
              :key="permission"
            >
              {{ permission }}
            </li>
          </ul>
        </div>

        <AlertDialogRoot>
          <AlertDialogTrigger as-child>
            <button
              class="revoke-button focus-ring"
              type="button"
              :disabled="Boolean(revokingId)"
              :aria-label="`撤销 API Key：${displayName(apiKey)}`"
            >
              <Trash2 :size="18" aria-hidden="true" />
              撤销
            </button>
          </AlertDialogTrigger>

          <AlertDialogPortal>
            <AlertDialogOverlay class="dialog-overlay" />
            <AlertDialogContent class="dialog-content">
              <p class="dialog-eyebrow">IRREVERSIBLE ACTION</p>
              <AlertDialogTitle class="dialog-title">
                撤销“{{ displayName(apiKey) }}”？
              </AlertDialogTitle>
              <AlertDialogDescription class="dialog-description">
                使用这个 API Key 的
                CLI、脚本或应用将立即失去访问权限。此操作无法撤销。
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
                    :disabled="Boolean(revokingId)"
                    @click="revokeApiKey(apiKey)"
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
.api-key-panel {
  display: grid;
  gap: var(--spacing-5);
  padding: clamp(var(--spacing-5), 5vw, var(--spacing-8));
  border: var(--border-width-surface) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-panel);
}

.panel-header,
.key-name-row,
.key-card,
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

h2,
h3,
.dialog-title {
  margin: 0;
  font-family: var(--font-display);
  font-weight: var(--font-weight-bold);
}

h2 {
  font-size: clamp(var(--text-2xl), 6vw, var(--text-4xl));
  line-height: var(--leading-tight);
}

.panel-copy,
.dialog-description {
  margin: 0;
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.create-form {
  display: grid;
  gap: var(--spacing-2);
}

.create-form label,
.create-form small {
  font-family: var(--font-mono);
}

.create-form label {
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
}

.create-form small {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.create-controls {
  display: flex;
  gap: var(--spacing-3);
}

.key-name-input {
  min-width: 0;
  min-height: var(--touch-target-min);
  flex: 1;
  padding: var(--spacing-2) var(--spacing-3);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-canvas);
  color: var(--text-primary);
  font: inherit;
}

.created-key {
  display: grid;
  gap: var(--spacing-2);
  padding: var(--spacing-4);
  border: var(--border-width-control) solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}

.created-key p {
  margin: 0;
  line-height: var(--leading-relaxed);
}

.created-key-label {
  font-weight: var(--font-weight-bold);
}

.created-key-controls {
  display: flex;
  gap: var(--spacing-3);
  align-items: stretch;
}

.created-key-value {
  min-width: 0;
  min-height: var(--touch-target-min);
  flex: 1;
  padding: var(--spacing-3);
  margin-top: 0;
  border: var(--border-width-thin) solid currentcolor;
  background: var(--surface-panel);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  user-select: all;
}

.created-key-announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.copy-feedback {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
}

.feedback,
.state-card,
.key-card {
  border: var(--border-width-control) solid var(--border-default);
}

.feedback {
  margin: 0;
  padding: var(--spacing-3) var(--spacing-4);
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

.feedback-warning {
  border-color: var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
}

.state-card {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  min-height: 5rem;
  padding: var(--spacing-4);
  background: var(--surface-elevated);
  font-family: var(--font-mono);
}

.state-card p,
.state-card small {
  margin: 0;
}

.error-state {
  justify-content: space-between;
}

.empty-state {
  display: grid;
  gap: var(--spacing-2);
}

.empty-state small {
  color: var(--text-muted);
  line-height: var(--leading-relaxed);
}

.loading-mark {
  width: var(--spacing-3);
  height: var(--spacing-3);
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--status-warning-bg);
  animation: pulse 1s steps(2, end) infinite;
}

.key-list {
  display: grid;
  gap: var(--spacing-4);
  padding: 0;
  margin: 0;
  list-style: none;
}

.key-card {
  padding: var(--spacing-4);
  background: var(--surface-elevated);
  box-shadow: var(--shadow-hard-sm);
}

.key-summary {
  min-width: 0;
}

.key-name-row {
  justify-content: flex-start;
}

h3 {
  overflow: hidden;
  font-size: var(--text-lg);
  text-overflow: ellipsis;
  white-space: nowrap;
}

code {
  display: block;
  margin-top: var(--spacing-2);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.expiry {
  margin: var(--spacing-2) 0 0;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.expiry-warning {
  width: fit-content;
  padding: var(--spacing-1) var(--spacing-2);
  border: var(--border-width-thin) solid var(--status-warning-border);
  background: var(--status-warning-bg);
  color: var(--status-warning-fg);
  font-weight: var(--font-weight-bold);
}

.permission-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
  padding: 0;
  margin: var(--spacing-3) 0 0;
  list-style: none;
}

.permission-list li {
  padding: var(--spacing-1) var(--spacing-2);
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--surface-subtle);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.status-badge {
  flex: none;
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
  width: min(calc(100% - 2 * var(--spacing-4)), 32rem);
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

@media (width < 36rem) {
  .create-controls,
  .created-key-controls {
    display: grid;
  }

  .key-card {
    display: grid;
  }

  .revoke-button {
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

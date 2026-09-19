<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import { ApiError } from "../../lib/http"
import type {
  AiAuthorizationStart,
  AiProviderDefinition,
} from "./ai-connections"
import {
  AI_AUTHORIZATION_STATE_LABELS,
  cancelAiAuthorization,
  createAiConnection,
  deleteAiConnection,
  describeAiModelCapabilities,
  describeAiProtocols,
  disconnectAiConnection,
  getAiAuthorization,
  listAiConnections,
  listAiProviders,
  pollAiAuthorization,
  readAiConnectionState,
  readAiPollDelayMs,
  refreshAiModels,
  renameAiConnection,
  setAiConnectionEnabled,
  startAiAuthorization,
} from "./ai-connections"

const list = useManagedList(listAiConnections)
const session = useSession()
const slug = shallowRef("")
const name = shallowRef("")
const authorization = shallowRef<AiAuthorizationStart | null>(null)
const authorizationConnection = shallowRef<string | null>(null)
const authorizationMessage = shallowRef("")
const provider = shallowRef<AiProviderDefinition | null>(null)
/** Guards against overlapping polls without sharing the list's busy gate. */
const pollInFlight = shallowRef(false)
let pollFailures = 0
/** Bounded retries: a dead session must not be polled forever (§5.1). */
const AI_POLL_FAILURE_LIMIT = 5

function isTerminalApiError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 403 || error.status === 404)
  )
}
const discoveryFailure = shallowRef<Record<string, string>>({})
let generation = 0
let disposed = false
let pollTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Design §5.1: a pending session can be resumed within its lifetime after the
 * page was closed, so the id survives a reload in this tab's session storage.
 */
const PENDING_AUTHORIZATION_KEY = "ai-pending-authorization"

interface PendingAuthorization {
  authorizationId: string
  connectionId: string
}

function rememberPendingAuthorization(pending: PendingAuthorization) {
  try {
    sessionStorage.setItem(PENDING_AUTHORIZATION_KEY, JSON.stringify(pending))
  } catch {
    // Storage can be unavailable; polling still works for this page view.
  }
}

function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const raw = sessionStorage.getItem(PENDING_AUTHORIZATION_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<PendingAuthorization>
    return typeof parsed.authorizationId === "string" &&
      typeof parsed.connectionId === "string"
      ? {
          authorizationId: parsed.authorizationId,
          connectionId: parsed.connectionId,
        }
      : null
  } catch {
    return null
  }
}

function forgetPendingAuthorization() {
  try {
    sessionStorage.removeItem(PENDING_AUTHORIZATION_KEY)
  } catch {
    // Nothing to clear.
  }
}

function stopPolling() {
  if (pollTimer !== null) clearTimeout(pollTimer)
  pollTimer = null
}

function schedulePoll(delayMs: number) {
  stopPolling()
  if (disposed) return
  pollTimer = setTimeout(() => void poll(), delayMs)
}

const authorizationExpiry = computed(() =>
  authorization.value
    ? new Date(authorization.value.expiresAt).toLocaleTimeString()
    : "",
)

function forgetAuthorization() {
  generation++
  stopPolling()
  forgetPendingAuthorization()
  authorization.value = null
  authorizationConnection.value = null
  authorizationMessage.value = ""
}

function stateLabel(connection: {
  authorizationStatus: string
  enabled: boolean
}): string {
  return AI_AUTHORIZATION_STATE_LABELS[readAiConnectionState(connection)]
}

function protocolLabel(): string {
  // Never assert a protocol the provider definition did not confirm.
  return provider.value === null
    ? "协议未确认"
    : describeAiProtocols(provider.value.responsesStyle)
}

async function create() {
  const ownSlug = slug.value
  const success = await list.mutate(async () => {
    await createAiConnection(ownSlug, name.value)
  })
  if (success && !disposed) {
    slug.value = ""
    name.value = ""
  }
}

async function beginAuthorization(id: string) {
  forgetAuthorization()
  const ownGeneration = generation
  await list.mutate(async () => {
    const started = await startAiAuthorization(id)
    if (disposed || generation !== ownGeneration) return
    authorization.value = started
    authorizationConnection.value = id
    authorizationMessage.value = "请在官方页面输入下方代码完成授权。"
    rememberPendingAuthorization({
      authorizationId: started.authorizationId,
      connectionId: id,
    })
    schedulePoll(readAiPollDelayMs(started, Date.now()))
  })
}

/**
 * Design §5.1: polling is scheduled by the server and must not depend on the
 * list controller's busy gate — a poll that fires while the list is refreshing
 * would otherwise be dropped and the loop would die silently.
 */
async function poll() {
  stopPolling()
  const started = authorization.value
  if (!started || disposed || pollInFlight.value) return
  pollInFlight.value = true
  const ownGeneration = generation
  try {
    let result: Awaited<ReturnType<typeof pollAiAuthorization>>
    try {
      result = await pollAiAuthorization(started.authorizationId)
      pollFailures = 0
    } catch (error) {
      if (disposed || generation !== ownGeneration) return
      // Design §6.1: after a client timeout the persisted session is read back
      // instead of replaying the exchange.
      const persisted = await readPersistedAuthorization(
        started.authorizationId,
      )
      if (disposed || generation !== ownGeneration) return
      if (persisted === null) {
        pollFailures += 1
        if (
          pollFailures >= AI_POLL_FAILURE_LIMIT ||
          isTerminalApiError(error)
        ) {
          forgetAuthorization()
          authorizationMessage.value = "授权会话已不可用，请重新开始授权。"
          return
        }
        authorizationMessage.value = "授权状态读取失败，稍后自动重试。"
        schedulePoll(5_000)
        return
      }
      pollFailures = 0
      result = persisted
    }
    if (disposed || generation !== ownGeneration) return
    switch (result.status) {
      case "completed": {
        // §5.1 step 8: the client issues its own catalog refresh after the
        // authorization commits, then reloads the connection snapshot.
        const connectionId = authorizationConnection.value
        forgetAuthorization()
        if (connectionId !== null) await refreshAfterAuthorization(connectionId)
        return
      }
      case "pending":
        authorizationMessage.value = "尚未完成，正在按上游节奏自动检查。"
        schedulePoll(readAiPollDelayMs(result, Date.now()))
        return
      case "poll-too-early":
        authorizationMessage.value = "检查过于频繁，稍后自动重试。"
        schedulePoll(readAiPollDelayMs(result, Date.now()))
        return
      case "expired":
        authorizationMessage.value = "授权会话已过期，请重新开始。"
        forgetAuthorization()
        return
      case "cancelled":
        authorizationMessage.value = "授权已取消，请重新开始。"
        forgetAuthorization()
        return
      case "connection-changed":
        authorizationMessage.value = "连接已变化，请重新开始授权。"
        forgetAuthorization()
        return
      case "poll-claim-held":
        // Transient: another tab holds the exchange claim (§5.1).
        authorizationMessage.value = "另一个标签页正在检查，稍后自动重试。"
        schedulePoll(readAiPollDelayMs(result, Date.now()))
        return
      default:
        authorizationMessage.value = "授权未完成，请重试或取消后重新开始。"
    }
  } finally {
    pollInFlight.value = false
  }
}

async function cancelAuthorization() {
  const started = authorization.value
  if (!started) return
  await list.mutate(async () => {
    await cancelAiAuthorization(started.authorizationId)
    forgetAuthorization()
  })
}

/**
 * §5.3: a failed update keeps the last snapshot and shows the failure. A
 * successful authorization whose catalog refresh fails must not read as an
 * authorization failure, so this path records the discovery error instead of
 * rethrowing into the shared list message.
 */
async function refreshAfterAuthorization(id: string) {
  let failure: string | null = null
  try {
    await refreshAiModels(id)
  } catch (error) {
    failure =
      error instanceof Error && error.message.length > 0
        ? error.message
        : "模型发现失败"
  }
  const remaining = { ...discoveryFailure.value }
  if (failure === null) delete remaining[id]
  else remaining[id] = failure
  discoveryFailure.value = remaining
  await list.load()
  if (disposed) return
  authorizationMessage.value =
    failure === null
      ? "授权完成，模型目录已刷新。"
      : `授权完成，但模型目录刷新失败：${failure}`
}

async function refresh(id: string) {
  const success = await list.mutate(async () => {
    try {
      await refreshAiModels(id)
      const remaining = { ...discoveryFailure.value }
      delete remaining[id]
      discoveryFailure.value = remaining
    } catch (error) {
      // §5.3: a failed update keeps the last snapshot and shows the failure.
      discoveryFailure.value = {
        ...discoveryFailure.value,
        [id]:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "模型发现失败",
      }
      throw error
    }
  })
  return success
}

async function disconnect(id: string) {
  await list.mutate(async () => {
    if (authorizationConnection.value === id) forgetAuthorization()
    await disconnectAiConnection(id)
  })
}

async function remove(id: string) {
  await list.mutate(async () => {
    if (authorizationConnection.value === id) forgetAuthorization()
    await deleteAiConnection(id)
  })
}

async function readPersistedAuthorization(
  authorizationId: string,
): Promise<Awaited<ReturnType<typeof getAiAuthorization>> | null> {
  try {
    return await getAiAuthorization(
      authorizationId,
      new AbortController().signal,
    )
  } catch {
    return null
  }
}

/** Resumes a pending session after the page was closed (§5.1). */
async function resumePendingAuthorization() {
  const pending = readPendingAuthorization()
  if (pending === null) return
  const status = await readPersistedAuthorization(pending.authorizationId)
  if (status === null) {
    forgetPendingAuthorization()
    return
  }
  if (status.status !== "pending") {
    forgetPendingAuthorization()
    if (status.status === "completed") await list.load()
    return
  }
  authorizationConnection.value = pending.connectionId
  authorizationMessage.value = "已恢复进行中的授权会话，继续自动检查。"
  authorization.value = {
    authorizationId: pending.authorizationId,
    expiresAt: status.expiresAt ?? Date.now(),
    intervalMs: 5_000,
    userCode: "",
    verificationUrl: provider.value?.deviceVerificationUrl ?? "",
  }
  schedulePoll(readAiPollDelayMs(status, Date.now()))
}

onMounted(async () => {
  await list.load()
  try {
    provider.value =
      (await listAiProviders(new AbortController().signal))[0] ?? null
  } catch {
    provider.value = null
  }
  await resumePendingAuthorization()
})
onUnmounted(() => {
  disposed = true
  stopPolling()
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">AI 接入</p>
    <h1>AI 连接</h1>
    <p>
      连接使用固定 Codex 提供方；slug
      创建后不可修改，模型目录来自上游账号的最近一次发现。
    </p>
    <form class="inline-form" @submit.prevent="create">
      <label
        >slug<input
          v-model="slug"
          required
          maxlength="64"
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          placeholder="codex-main"
          :disabled="list.busy.value"
      /></label>
      <label
        >名称<input
          v-model="name"
          required
          maxlength="200"
          :disabled="list.busy.value"
      /></label>
      <button class="primary pressable" :disabled="list.busy.value">
        新建连接
      </button>
    </form>
    <p role="status">{{ list.message.value }}</p>
    <template v-if="list.needsReauthentication.value"
      ><button class="pressable" @click="session.signInPasskey">
        使用 Passkey 重新验证</button
      ><button class="pressable" @click="session.signIn">
        使用 GitHub 重新验证
      </button></template
    >
    <ul class="credential-list">
      <li v-for="connection in list.items.value" :key="connection.id">
        <h2>{{ connection.name }} · {{ connection.slug }}</h2>
        <p data-testid="ai-connection-state">
          <strong>{{ stateLabel(connection) }}</strong> ·
          {{ connection.providerType }} · 账号
          {{ connection.upstreamAccount }} ·
          {{ connection.enabled ? "已启用" : "已停用" }} ·
          {{
            connection.credentialExpiresAt
              ? `凭证至 ${new Date(connection.credentialExpiresAt).toLocaleString()}`
              : "无有效凭证"
          }}
        </p>
        <p
          v-if="discoveryFailure[connection.id]"
          class="notice"
          role="status"
          data-testid="ai-discovery-failure"
        >
          模型发现失败：{{
            discoveryFailure[connection.id]
          }}（仍显示上一次成功快照）
        </p>
        <label
          >名称<input
            :value="connection.name"
            maxlength="200"
            :disabled="list.busy.value"
            @change="
              list.mutate(() =>
                renameAiConnection(
                  connection.id,
                  ($event.target as HTMLInputElement).value,
                ),
              )
            "
        /></label>
        <section
          v-if="connection.models.length > 0"
          class="notice"
          aria-label="模型目录"
          data-testid="ai-model-catalog"
        >
          <p>
            模型目录（{{ connection.models.length }} 个 · 协议
            {{ protocolLabel() }}）
          </p>
          <ul>
            <li v-for="model in connection.models" :key="model.id">
              <strong>{{ model.id }}</strong>
              <template v-if="model.displayName">
                · {{ model.displayName }}</template
              >
              <br />
              能力：{{ describeAiModelCapabilities(model.capabilities) }}<br />
              最近发现 {{ new Date(model.discoveredAt).toLocaleString() }}
            </li>
          </ul>
        </section>
        <p v-else role="status" data-testid="ai-catalog-empty">
          目录为空：可能是尚未成功发现模型，或上游本次返回了 0
          个模型。在确认之前不声明模型可用。
        </p>
        <button
          class="pressable"
          :disabled="list.busy.value"
          @click="
            list.mutate(() =>
              setAiConnectionEnabled(connection.id, !connection.enabled),
            )
          "
        >
          {{ connection.enabled ? "停用" : "启用" }}
        </button>
        <button
          class="pressable"
          :disabled="list.busy.value"
          @click="beginAuthorization(connection.id)"
        >
          开始设备授权
        </button>
        <button
          class="pressable"
          :disabled="list.busy.value"
          @click="refresh(connection.id)"
        >
          刷新模型
        </button>
        <ConfirmAction
          action-label="断开"
          :busy="list.busy.value"
          title="断开连接"
          description="断开后清空凭证，需要重新授权才能继续调用。"
          @confirm="disconnect(connection.id)"
        />
        <ConfirmAction
          action-label="删除"
          :busy="list.busy.value"
          title="删除连接"
          description="删除会移除连接与模型快照；已签发的 Key 对该连接的模型许可随之失效。"
          @confirm="remove(connection.id)"
        />
      </li>
    </ul>
    <section
      v-if="authorization"
      class="notice"
      aria-label="设备授权"
      data-testid="ai-authorization"
    >
      <p>
        在
        <a :href="authorization.verificationUrl" rel="noreferrer noopener"
          >官方验证页</a
        >
        输入代码（{{ authorizationExpiry }} 前有效）：
      </p>
      <input
        :value="authorization.userCode"
        readonly
        aria-label="设备授权代码"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="pressable" :disabled="list.busy.value" @click="poll">
        检查授权状态
      </button>
      <button
        class="pressable"
        :disabled="list.busy.value"
        @click="cancelAuthorization"
      >
        取消授权
      </button>
    </section>
    <p
      v-if="authorizationMessage"
      role="status"
      data-testid="ai-authorization-message"
    >
      {{ authorizationMessage }}
    </p>
    <button class="pressable" :disabled="list.busy.value" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

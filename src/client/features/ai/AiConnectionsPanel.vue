<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import {
  AI_AUTHORIZATION_STATE_LABELS,
  createAiConnection,
  deleteAiConnection,
  disconnectAiConnection,
  describeAiModelCapabilities,
  describeAiProtocols,
  listAiConnections,
  listAiProviders,
  readAiConnectionState,
  refreshAiModels,
  renameAiConnection,
  saveAiCredential,
  setAiConnectionEnabled,
  type AiProviderDefinition,
} from "./ai-connections"
import AiCredentialForm from "./AiCredentialForm.vue"
const list = useManagedList(listAiConnections)
const session = useSession()
const name = shallowRef("")
const loadingPanel = shallowRef(true)
const panelBusy = computed(() => list.busy.value || loadingPanel.value)
const provider = shallowRef<AiProviderDefinition | null>(null)
const discoveryFailure = shallowRef<Record<string, string>>({})
let disposed = false
const stateLabel = (connection: {
  enabled: boolean
  authorizationStatus: string
}) => AI_AUTHORIZATION_STATE_LABELS[readAiConnectionState(connection)]
const protocolLabel = () =>
  provider.value
    ? describeAiProtocols(provider.value.responsesStyle)
    : "协议未确认"
async function create() {
  if (await list.mutate(() => createAiConnection(name.value))) {
    name.value = ""
  }
}
async function refresh(id: string) {
  const sessionId = session.data.value?.session.id
  const handleFailure = session.captureCredentialFailureHandler()
  await list.mutate(async () => {
    try {
      await refreshAiModels(id)
      if (!disposed && sessionId === session.data.value?.session.id)
        discoveryFailure.value = { ...discoveryFailure.value, [id]: "" }
    } catch (error) {
      if (
        disposed ||
        sessionId !== session.data.value?.session.id ||
        handleFailure(error)
      )
        return
      discoveryFailure.value = {
        ...discoveryFailure.value,
        [id]: error instanceof Error ? error.message : "上游暂不可用",
      }
    }
  })
}
async function save(
  id: string,
  input: { apiKey: string; expectedVersion: number },
) {
  const sessionId = session.data.value?.session.id
  const saved = await list.mutate(() =>
    saveAiCredential(id, input.apiKey, input.expectedVersion),
  )
  if (
    saved &&
    !disposed &&
    sessionId === session.data.value?.session.id &&
    session.status.value === "authenticated"
  )
    await refresh(id)
}
const disconnect = (id: string) => list.mutate(() => disconnectAiConnection(id))
const remove = (id: string) => list.mutate(() => deleteAiConnection(id))
onMounted(async () => {
  const handleFailure = session.captureCredentialFailureHandler()
  await list.load()
  try {
    const providers = await listAiProviders(new AbortController().signal)
    if (!disposed) provider.value = providers[0] ?? null
  } catch (error) {
    if (!disposed) handleFailure(error)
  } finally {
    if (!disposed) loadingPanel.value = false
  }
})
onUnmounted(() => {
  disposed = true
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">AI 接入</p>
    <h1>AI 连接</h1>
    <p>
      连接使用 DeepSeek 官方 API
      Key，模型目录来自上游账号的最近一次发现。调用时直接使用上游模型名。
    </p>
    <form class="inline-form" @submit.prevent="create">
      <label
        >名称<input
          v-model="name"
          required
          maxlength="100"
          :disabled="panelBusy"
      /></label>
      <button class="primary pressable" :disabled="panelBusy">新建连接</button>
    </form>
    <p role="status">{{ list.message.value }}</p>
    <ul class="credential-list">
      <li v-for="connection in list.items.value" :key="connection.id">
        <h2>{{ connection.name }} · {{ connection.id.slice(0, 8) }}</h2>
        <p data-testid="ai-connection-state">
          <strong>{{ stateLabel(connection) }}</strong> ·
          {{ connection.providerType }} ·
          {{ connection.enabled ? "已启用" : "已停用" }}
        </p>
        <p
          v-if="discoveryFailure[connection.id]"
          class="notice"
          role="status"
          data-testid="ai-discovery-failure"
        >
          模型发现失败：{{
            discoveryFailure[connection.id]
          }}。修复后可再次刷新模型。
        </p>
        <label
          >名称<input
            :value="connection.name"
            maxlength="100"
            :disabled="panelBusy"
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
          :disabled="panelBusy"
          @click="
            list.mutate(() =>
              setAiConnectionEnabled(connection.id, !connection.enabled),
            )
          "
        >
          {{ connection.enabled ? "停用" : "启用" }}
        </button>
        <AiCredentialForm
          :connection-id="connection.id"
          :expected-version="connection.credentialVersion"
          :busy="panelBusy"
          @save="save(connection.id, $event)"
        />
        <button
          class="pressable"
          :disabled="panelBusy"
          @click="refresh(connection.id)"
        >
          刷新模型
        </button>
        <ConfirmAction
          action-label="断开"
          :busy="panelBusy"
          title="断开连接"
          description="断开会清除上游 Key 并撤销该连接的所有模型许可。重新配置 Key 后，需在调用 Key 管理中重新授权。"
          @confirm="disconnect(connection.id)"
        />
        <ConfirmAction
          action-label="删除"
          :busy="panelBusy"
          title="删除连接"
          description="删除会移除连接与模型快照；已签发的 Key 对该连接的模型许可随之失效。"
          @confirm="remove(connection.id)"
        />
      </li>
    </ul>
    <button class="pressable" :disabled="panelBusy" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

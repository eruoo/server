<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import type { AiAuthorizationStart } from "./ai-connections"
import {
  cancelAiAuthorization,
  createAiConnection,
  deleteAiConnection,
  disconnectAiConnection,
  listAiConnections,
  pollAiAuthorization,
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
let generation = 0
let disposed = false

const authorizationExpiry = computed(() =>
  authorization.value
    ? new Date(authorization.value.expiresAt).toLocaleTimeString()
    : "",
)

function forgetAuthorization() {
  generation++
  authorization.value = null
  authorizationConnection.value = null
  authorizationMessage.value = ""
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
  })
}

async function poll() {
  const started = authorization.value
  if (!started) return
  const ownGeneration = generation
  await list.mutate(async () => {
    const result = await pollAiAuthorization(started.authorizationId)
    if (disposed || generation !== ownGeneration) return
    switch (result.status) {
      case "completed":
        authorizationMessage.value = "授权完成，正在刷新模型目录。"
        forgetAuthorization()
        await list.load()
        return
      case "pending":
        authorizationMessage.value = "尚未完成，请稍后再次检查。"
        return
      case "poll-too-early":
        authorizationMessage.value = "检查过于频繁，请稍后再试。"
        return
      case "expired":
        authorizationMessage.value = "授权会话已过期，请重新开始。"
        forgetAuthorization()
        return
      default:
        authorizationMessage.value = "授权未完成，请重试或取消后重新开始。"
    }
  })
}

async function cancelAuthorization() {
  const started = authorization.value
  if (!started) return
  await list.mutate(async () => {
    await cancelAiAuthorization(started.authorizationId)
    forgetAuthorization()
  })
}

async function refresh(id: string) {
  await list.mutate(async () => {
    await refreshAiModels(id)
  })
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

onMounted(list.load)
onUnmounted(() => {
  disposed = true
  forgetAuthorization()
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
        <p>
          {{ connection.authorizationStatus }} ·
          {{ connection.enabled ? "已启用" : "已停用" }} ·
          {{
            connection.credentialExpiresAt
              ? `凭证至 ${new Date(connection.credentialExpiresAt).toLocaleString()}`
              : "无有效凭证"
          }}
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
        <p>
          模型 {{ connection.models.length }} 个<template
            v-if="connection.models.length > 0"
            >：{{
              connection.models
                .map((model) => model.id)
                .slice(0, 5)
                .join("、")
            }}<template v-if="connection.models.length > 5"
              >…</template
            ></template
          >
        </p>
        <button
          class="pressable"
          :disabled="list.busy.value"
          @click="setAiConnectionEnabled(connection.id, !connection.enabled)"
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
      <p role="status">{{ authorizationMessage }}</p>
    </section>
    <button class="pressable" :disabled="list.busy.value" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

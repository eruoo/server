<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import {
  API_KEY_AI_CONFIG_ID,
  API_KEY_DEFAULT_CONFIG_ID,
} from "../../../shared/api-key"
import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import { copyCredential, clipboardBusy } from "../../lib/clipboard"
import { listAiConnections } from "../ai/ai-connections"
import type { AiConnection } from "../ai/ai-connections"
import {
  createApiKeyForProfile,
  listApiKeysForProfile,
  removeApiKeyFromProfile,
  renameApiKeyInProfile,
  updateAiKeyModelGrants,
} from "./api-keys"

// The profile is always named explicitly: reads and mutations never mix the
// two profiles, and only creation carries the `purpose` selector.
const profile = shallowRef<string>(API_KEY_DEFAULT_CONFIG_ID)
const connections = shallowRef<AiConnection[]>([])
const list = useManagedList((signal) =>
  listApiKeysForProfile(signal, profile.value),
)
const session = useSession()
const name = shallowRef("")
const days = shallowRef(180)
const selectedModels = shallowRef<string[]>([])
const grantDraft = shallowRef<Record<string, string[]>>({})
const catalogLoaded = shallowRef(false)
const secret = shallowRef<{ id: string; value: string } | null>(null)
const copyMessage = shallowRef("")
const aiProfile = computed(() => profile.value === API_KEY_AI_CONFIG_ID)
const availableModels = computed(() =>
  connections.value.flatMap((connection) =>
    connection.models.map((model) => `${connection.slug}/${model.id}`),
  ),
)
let generation = 0
let disposed = false
function forget() {
  generation++
  secret.value = null
  copyMessage.value = ""
}
function toggleModel(modelId: string) {
  selectedModels.value = selectedModels.value.includes(modelId)
    ? selectedModels.value.filter((value) => value !== modelId)
    : [...selectedModels.value, modelId]
}
async function loadConnections() {
  try {
    connections.value = await listAiConnections(new AbortController().signal)
    catalogLoaded.value = true
  } catch {
    connections.value = []
    catalogLoaded.value = false
  }
}
async function switchProfile(next: string) {
  if (next === profile.value) return
  forget()
  profile.value = next
  selectedModels.value = []
  grantDraft.value = {}
  if (next === API_KEY_AI_CONFIG_ID) await loadConnections()
  await list.load()
}
async function create() {
  forget()
  const ownGeneration = generation
  const success = await list.mutate(async () => {
    const key = await createApiKeyForProfile({
      configId: profile.value,
      days: days.value,
      ...(aiProfile.value ? { modelIds: selectedModels.value } : {}),
      name: name.value,
    })
    if (!disposed && generation === ownGeneration)
      secret.value = { id: key.id, value: key.key }
  })
  if (success && !disposed) {
    name.value = ""
    selectedModels.value = []
  }
}
async function revoke(id: string) {
  await list.mutate(async () => {
    await removeApiKeyFromProfile(profile.value, id)
    if (secret.value?.id === id) forget()
  })
}
/** The stored key view is read-only in the client plugin's types. */
type KeyWithGrants = {
  id: string
  name?: string | null
  permissions?: Readonly<Record<string, readonly string[]>> | null
}

const AI_MODEL_PERMISSION_PREFIX = "ai-model:"

/**
 * Maps stored grants back to the public model IDs the owner selected. A
 * grant whose connection no longer exists has no public ID and is dropped;
 * saving then replaces it, which is exactly the server-side semantics.
 */
function grantedModels(key: KeyWithGrants): string[] {
  const permissions = key.permissions
  if (!permissions) return []
  return Object.entries(permissions)
    .filter(([action]) => action.startsWith(AI_MODEL_PERMISSION_PREFIX))
    .flatMap(([action, models]) => {
      const connectionId = action.slice(AI_MODEL_PERMISSION_PREFIX.length)
      const connection = connections.value.find(
        (candidate) => candidate.id === connectionId,
      )
      return connection === undefined
        ? []
        : [...models].map((model) => `${connection.slug}/${model}`)
    })
}
function draftFor(key: KeyWithGrants): string {
  return (grantDraft.value[key.id] ?? grantedModels(key)).join(", ")
}
function updateDraft(key: KeyWithGrants, value: string) {
  grantDraft.value = {
    ...grantDraft.value,
    [key.id]: value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  }
}
async function saveGrants(key: KeyWithGrants) {
  const draft = grantDraft.value[key.id]
  // Saving while the catalog is unknown would silently drop every grant whose
  // connection cannot be resolved, so it stays disabled instead.
  if (draft === undefined || !catalogLoaded.value) return
  await list.mutate(async () => {
    await updateAiKeyModelGrants(key.id, key.name ?? "", draft)
    const next = { ...grantDraft.value }
    delete next[key.id]
    grantDraft.value = next
  })
}
async function copy() {
  const ownGeneration = generation
  try {
    if (!secret.value) return
    await copyCredential(secret.value.value)
    if (ownGeneration === generation && !disposed) copyMessage.value = "已复制"
  } catch {
    if (ownGeneration === generation && !disposed)
      copyMessage.value = "复制失败，请手动选择并复制。"
  }
}
onMounted(async () => {
  await loadConnections()
  await list.load()
})
onUnmounted(() => {
  disposed = true
  forget()
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">服务访问</p>
    <h1>API Key</h1>
    <p>
      状态密钥只用于读取服务状态；AI
      密钥用于推理调用，模型许可由所选模型决定。完整密钥只显示一次。
    </p>
    <div class="profile-switch" role="tablist" aria-label="密钥档位">
      <button
        class="pressable"
        :aria-selected="!aiProfile"
        role="tab"
        :disabled="list.busy.value"
        @click="switchProfile(API_KEY_DEFAULT_CONFIG_ID)"
      >
        状态密钥
      </button>
      <button
        class="pressable"
        :aria-selected="aiProfile"
        role="tab"
        :disabled="list.busy.value"
        @click="switchProfile(API_KEY_AI_CONFIG_ID)"
      >
        AI 密钥
      </button>
    </div>
    <form class="inline-form" @submit.prevent="create">
      <label
        >名称<input
          v-model="name"
          data-testid="key-name"
          required
          maxlength="100"
          :disabled="list.busy.value"
      /></label>
      <label
        >有效天数<input
          v-model.number="days"
          type="number"
          required
          min="1"
          max="365"
          step="1"
          :disabled="list.busy.value"
      /></label>
      <button
        class="primary pressable"
        :disabled="
          list.busy.value ||
          (aiProfile && selectedModels.length === 0) ||
          (aiProfile && availableModels.length === 0)
        "
      >
        创建密钥
      </button>
    </form>
    <fieldset
      v-if="aiProfile"
      class="model-grants"
      data-testid="ai-model-grants"
    >
      <legend>模型许可（至少选择一个）</legend>
      <p v-if="availableModels.length === 0">
        暂无可选模型：请先创建连接并完成设备授权、刷新模型目录。
      </p>
      <label v-for="model in availableModels" :key="model">
        <input
          type="checkbox"
          :checked="selectedModels.includes(model)"
          :disabled="list.busy.value"
          @change="toggleModel(model)"
        />
        {{ model }}
      </label>
    </fieldset>
    <section v-if="secret" class="notice" aria-label="新密钥">
      <p>请保存密钥。关闭此处或离开页面后无法再次查看。</p>
      <input
        :value="secret.value"
        readonly
        aria-label="完整密钥"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="pressable" :disabled="clipboardBusy" @click="copy">
        复制密钥</button
      ><button class="pressable" @click="forget">已保存，关闭</button>
      <p role="status">{{ copyMessage }}</p>
    </section>
    <p role="status">{{ list.message.value }}</p>
    <template v-if="list.needsReauthentication.value"
      ><button class="pressable" @click="session.signInPasskey">
        使用 Passkey 重新验证</button
      ><button class="pressable" @click="session.signIn">
        使用 GitHub 重新验证
      </button></template
    >
    <ul class="credential-list">
      <li v-for="key in list.items.value" :key="key.id">
        <label
          >名称<input
            :value="key.name ?? ''"
            maxlength="100"
            :disabled="list.busy.value"
            @change="
              list.mutate(() =>
                renameApiKeyInProfile(
                  profile,
                  key.id,
                  ($event.target as HTMLInputElement).value,
                ),
              )
            "
        /></label>
        <p>
          {{ key.start }}… ·
          {{
            key.expiresAt
              ? new Date(key.expiresAt).toLocaleDateString()
              : "有效期异常"
          }}
        </p>
        <template v-if="aiProfile">
          <label
            >模型许可<input
              :value="draftFor(key)"
              data-testid="key-grant"
              :disabled="list.busy.value"
              @input="
                updateDraft(key, ($event.target as HTMLInputElement).value)
              "
          /></label>
          <button
            class="pressable"
            :disabled="list.busy.value || !catalogLoaded"
            @click="saveGrants(key)"
          >
            保存模型许可
          </button>
          <p v-if="!catalogLoaded" role="status">
            模型目录未加载，无法安全替换许可；请先刷新。
          </p>
        </template>
        <ConfirmAction
          action-label="撤销"
          :busy="list.busy.value || session.status.value !== 'authenticated'"
          title="撤销 API Key"
          description="撤销后，此密钥立即停止访问服务。"
          @confirm="revoke(key.id)"
        />
      </li>
    </ul>
    <button class="pressable" :disabled="list.busy.value" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

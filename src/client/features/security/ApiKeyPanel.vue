<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import {
  API_KEY_AI_CONFIG_ID,
  API_KEY_DEFAULT_CONFIG_ID,
  readAiKeyConnectionGrant,
} from "../../../shared/api-key"
import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import { copyCredential, clipboardBusy } from "../../lib/clipboard"
import { listAiConnections } from "../ai/ai-connections"
import type { AiConnection } from "../ai/ai-connections"
import AiModelGrantFields from "../ai/AiModelGrantFields.vue"
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
const selectedConnectionId = shallowRef("")
const selectedModels = shallowRef<string[]>([])
type ModelGrantDraft = { connectionId: string; modelIds: string[] }
const grantDraft = shallowRef<Record<string, ModelGrantDraft>>({})
const catalogLoaded = shallowRef(false)
const secret = shallowRef<{ id: string; value: string } | null>(null)
const copyMessage = shallowRef("")
/**
 * True while the panel loads its own view: the connection catalog plus the key
 * list of the active profile. The form and the rows stay disabled for that
 * whole window — a field that is enabled while a read is still on its way
 * would be disabled again by that read and silently drop what was typed.
 */
const loadingProfile = shallowRef(true)
const panelBusy = computed(() => list.busy.value || loadingProfile.value)
const aiProfile = computed(() => profile.value === API_KEY_AI_CONFIG_ID)
let generation = 0
let disposed = false
function forget() {
  generation++
  secret.value = null
  copyMessage.value = ""
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
/**
 * Loads everything the active profile's view needs under one busy window.
 * Both reads handle their own failures and always resolve, so the combined
 * wait never rejects.
 */
async function loadProfileView() {
  loadingProfile.value = true
  try {
    await Promise.all([loadConnections(), list.load()])
  } finally {
    loadingProfile.value = false
  }
}
async function switchProfile(next: string) {
  if (next === profile.value || panelBusy.value) return
  forget()
  // The visible list belongs to the profile that is being left: drop it before
  // the first await, so a failed read can neither show the previous profile's
  // keys nor let a row action reach them with the new configId.
  list.reset()
  profile.value = next
  selectedConnectionId.value = ""
  selectedModels.value = []
  grantDraft.value = {}
  await loadProfileView()
}
async function create() {
  forget()
  const ownGeneration = generation
  const success = await list.mutate(async () => {
    const key = await createApiKeyForProfile({
      configId: profile.value,
      days: days.value,
      ...(aiProfile.value
        ? {
            connectionId: selectedConnectionId.value,
            modelIds: selectedModels.value,
          }
        : {}),
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

function draftFor(key: KeyWithGrants): ModelGrantDraft {
  const draft = grantDraft.value[key.id]
  if (draft) return draft
  const grant = readAiKeyConnectionGrant(key.permissions)
  if (!grant) return { connectionId: "", modelIds: [] }
  const connection = connections.value.find(
    (entry) => entry.id === grant.connectionId,
  )
  return {
    connectionId: grant.connectionId,
    modelIds:
      connection?.permissionVersion === grant.permissionVersion
        ? grant.modelIds
        : [],
  }
}
function updateDraft(key: KeyWithGrants, patch: Partial<ModelGrantDraft>) {
  grantDraft.value = {
    ...grantDraft.value,
    [key.id]: { ...draftFor(key), ...patch },
  }
}
async function saveGrants(key: KeyWithGrants) {
  const draft = draftFor(key)
  if (!draft.connectionId || !catalogLoaded.value) return
  await list.mutate(async () => {
    await updateAiKeyModelGrants(
      key.id,
      key.name ?? "",
      draft.connectionId,
      draft.modelIds,
    )
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
onMounted(loadProfileView)
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
        :disabled="panelBusy"
        @click="switchProfile(API_KEY_DEFAULT_CONFIG_ID)"
      >
        状态密钥
      </button>
      <button
        class="pressable"
        :aria-selected="aiProfile"
        role="tab"
        :disabled="panelBusy"
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
          :disabled="panelBusy"
      /></label>
      <label
        >有效天数<input
          v-model.number="days"
          type="number"
          required
          min="1"
          max="365"
          step="1"
          :disabled="panelBusy"
      /></label>
      <button
        class="primary pressable"
        :disabled="
          panelBusy ||
          (aiProfile && selectedModels.length === 0) ||
          (aiProfile && !selectedConnectionId)
        "
      >
        创建密钥
      </button>
    </form>
    <AiModelGrantFields
      v-if="aiProfile"
      v-model:connection-id="selectedConnectionId"
      v-model:model-ids="selectedModels"
      :connections="connections"
      :disabled="panelBusy"
    />
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
            :disabled="panelBusy"
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
          <AiModelGrantFields
            :connection-id="draftFor(key).connectionId"
            :model-ids="draftFor(key).modelIds"
            :connections="connections"
            :disabled="panelBusy || !catalogLoaded"
            @update:connection-id="updateDraft(key, { connectionId: $event })"
            @update:model-ids="updateDraft(key, { modelIds: $event })"
          />
          <button
            class="pressable"
            :disabled="
              panelBusy || !catalogLoaded || !draftFor(key).connectionId
            "
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
          :busy="panelBusy || session.status.value !== 'authenticated'"
          title="撤销 API Key"
          description="撤销后，此密钥立即停止访问服务。"
          @confirm="revoke(key.id)"
        />
      </li>
    </ul>
    <button class="pressable" :disabled="panelBusy" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

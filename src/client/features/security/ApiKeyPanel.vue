<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue"

import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import { copyCredential, clipboardBusy } from "../../lib/clipboard"
import {
  listApiKeys,
  createApiKey,
  renameApiKey,
  removeApiKey,
} from "./api-keys"
const list = useManagedList(listApiKeys)
const session = useSession()
const name = shallowRef("")
const days = shallowRef(180)
const secret = shallowRef<{ id: string; value: string } | null>(null)
const copyMessage = shallowRef("")
let generation = 0
let disposed = false
function forget() {
  generation++
  secret.value = null
  copyMessage.value = ""
}
async function create() {
  forget()
  const ownGeneration = generation
  const success = await list.mutate(async () => {
    const key = await createApiKey(name.value, days.value)
    if (!disposed && generation === ownGeneration)
      secret.value = { id: key.id, value: key.key }
  })
  if (success && !disposed) name.value = ""
}
async function revoke(id: string) {
  await list.mutate(async () => {
    await removeApiKey(id)
    if (secret.value?.id === id) forget()
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
onMounted(list.load)
onUnmounted(() => {
  disposed = true
  forget()
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">服务访问</p>
    <h1>API Key</h1>
    <p>密钥仅用于读取服务状态，有效期为 1–365 天。完整密钥只显示一次。</p>
    <form class="inline-form" @submit.prevent="create">
      <label
        >名称<input
          v-model="name"
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
      <button class="primary pressable" :disabled="list.busy.value">
        创建密钥
      </button>
    </form>
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
                renameApiKey(key.id, ($event.target as HTMLInputElement).value),
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

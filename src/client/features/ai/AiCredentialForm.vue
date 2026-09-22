<script setup lang="ts">
import { onUnmounted, shallowRef, watch } from "vue"

import { useSession } from "../../composables/session"
const props = defineProps<{
  connectionId: string
  expectedVersion: number
  busy: boolean
}>()
const emit = defineEmits<{
  save: [input: { apiKey: string; expectedVersion: number }]
}>()
const apiKey = shallowRef("")
const session = useSession()
watch(
  [() => session.data.value?.session.id, () => session.data.value?.user.id],
  () => {
    apiKey.value = ""
  },
)
onUnmounted(() => {
  apiKey.value = ""
})
function submit() {
  const value = apiKey.value
  apiKey.value = ""
  emit("save", { apiKey: value, expectedVersion: props.expectedVersion })
}
</script>
<template>
  <form class="inline-form" @submit.prevent="submit">
    <label :for="`upstream-key-${connectionId}`">DeepSeek API Key</label>
    <input
      :id="`upstream-key-${connectionId}`"
      v-model="apiKey"
      type="password"
      required
      maxlength="2048"
      autocomplete="off"
      :spellcheck="false"
      :disabled="busy"
    />
    <button class="pressable" :disabled="busy || !apiKey">保存 Key</button>
    <p>
      更换 Key 后，已授权应用继续使用新
      Key；模型目录会重新获取。无需先断开连接。
    </p>
  </form>
</template>

<script setup lang="ts">
import type { PasskeyRecord } from "../../features/security/passkeys"
import ConfirmAction from "./ConfirmAction.vue"
defineProps<{ items: readonly PasskeyRecord[]; busy: boolean }>()
const emit = defineEmits<{
  rename: [id: string, name: string]
  remove: [id: string]
}>()
function rename(id: string, event: Event) {
  const input = event.target as HTMLInputElement
  const name = input.value.trim()
  if (name) emit("rename", id, name)
}
</script>
<template>
  <p v-if="!items.length" class="empty">
    尚未添加 Passkey。添加后可使用设备解锁方式登录。
  </p>
  <ul v-else class="credential-list">
    <li v-for="item in items" :key="item.id">
      <label
        >Passkey 名称<input
          :value="item.name"
          :disabled="busy"
          maxlength="100"
          @change="rename(item.id, $event)"
      /></label>
      <span>{{ new Date(item.createdAt).toLocaleDateString() }}</span>
      <ConfirmAction
        :title="`删除 ${item.name || 'Passkey'}？`"
        :description="
          items.length === 1
            ? '这是最后一把 Passkey，删除后需要通过 GitHub 登录。'
            : '此 Passkey 将无法再用于登录。'
        "
        :busy="busy"
        @confirm="emit('remove', item.id)"
      />
    </li>
  </ul>
</template>

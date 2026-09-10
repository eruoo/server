<script setup lang="ts">
import { onMounted } from "vue"

import CredentialNameForm from "../../components/security/CredentialNameForm.vue"
import PasskeyList from "../../components/security/PasskeyList.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import {
  addPasskey,
  listPasskeys,
  removePasskey,
  renamePasskey,
} from "./passkeys"
const list = useManagedList(listPasskeys)
const session = useSession()
onMounted(list.load)
</script>
<template>
  <section class="panel">
    <p class="eyebrow">登录与身份</p>
    <h1>Passkey</h1>
    <p>使用设备解锁方式登录。GitHub 始终作为恢复入口。</p>
    <CredentialNameForm
      :busy="list.busy.value || session.status.value !== 'authenticated'"
      label="添加 Passkey"
      @submit="(name) => list.mutate(() => addPasskey(name))"
    />
    <p v-if="list.message.value" role="status" class="notice">
      {{ list.message.value }}
    </p>
    <button
      v-if="list.needsReauthentication.value"
      @click="session.signInPasskey"
    >
      使用 Passkey 重新验证
    </button>
    <button v-if="list.needsReauthentication.value" @click="session.signIn">
      使用 GitHub 重新验证
    </button>
    <PasskeyList
      :items="list.items.value"
      :busy="list.busy.value || session.status.value !== 'authenticated'"
      @rename="(id, name) => list.mutate(() => renamePasskey(id, name))"
      @remove="(id) => list.mutate(() => removePasskey(id))"
    />
    <button :disabled="list.busy.value" @click="list.load">刷新列表</button>
  </section>
</template>

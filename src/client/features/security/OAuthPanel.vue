<script setup lang="ts">
import { onMounted } from "vue"
import type { z } from "zod"

import type { oauthAuthorizationListSchema } from "../../../shared/oauth-authorizations"
import ConfirmAction from "../../components/security/ConfirmAction.vue"
import { useManagedList } from "../../composables/managed-list"
import { useSession } from "../../composables/session"
import { requestJson } from "../../lib/http"
const session = useSession()
const list = useManagedList((signal) =>
  requestJson<z.infer<typeof oauthAuthorizationListSchema>>(
    "/api/oauth/authorizations",
    { signal },
  ),
)
const revoke = (id: string) =>
  list.mutate(() =>
    requestJson(`/api/oauth/authorizations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  )
onMounted(list.load)
</script>
<template>
  <section class="panel">
    <p class="eyebrow">授权管理</p>
    <h1>已授权应用</h1>
    <p>撤销会停止离线续期。已经签发的访问凭证最多还能使用 1 小时。</p>
    <p role="status">{{ list.message.value }}</p>
    <template v-if="list.needsReauthentication.value"
      ><button class="pressable" @click="session.signInPasskey">
        使用 Passkey 重新验证</button
      ><button class="pressable" @click="session.signIn">
        使用 GitHub 重新验证
      </button></template
    >
    <ul class="credential-list">
      <li v-for="app in list.items.value" :key="app.clientId">
        <h2>{{ app.name }}</h2>
        <p>
          {{
            !app.enabled ? "尚未开放" : app.authorized ? "已授权" : "尚未授权"
          }}
        </p>
        <p v-if="app.authorized">权限：{{ app.scopes.join("、") }}</p>
        <ConfirmAction
          v-if="app.enabled && app.authorized && app.supportsOfflineAccess"
          action-label="撤销"
          title="撤销应用授权"
          description="此应用将不能继续刷新凭证。已签发的访问凭证最多还能使用 1 小时。"
          :busy="list.busy.value || session.status.value !== 'authenticated'"
          @confirm="revoke(app.clientId)"
        />
      </li>
    </ul>
    <button class="pressable" :disabled="list.busy.value" @click="list.load">
      刷新列表
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onUnmounted, shallowRef, watch } from "vue"
import { useRoute } from "vue-router"

import { oauthClients, oauthScopes } from "../../shared/oauth"
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import { useSession } from "../composables/session"
import {
  inspectLoginContinuationLocation,
  isInvalidOAuthContinuationError,
} from "../features/auth/login-continuation"
import { authClient } from "../lib/auth-client"
import { redirectAuthenticationResult } from "../lib/auth-redirect"
const route = useRoute()
const session = useSession()
const client = computed(() =>
  oauthClients.find(
    (client) => client.enabled && client.clientId === route.query.client_id,
  ),
)
const scopes = computed(() =>
  typeof route.query.scope === "string"
    ? route.query.scope
        .split(" ")
        .filter((scope) => oauthScopes.some((allowed) => allowed === scope))
    : [],
)
const busy = shallowRef(false)
const message = shallowRef("")
let generation = 0
onUnmounted(() => {
  generation++
})
watch(
  [
    () => route.fullPath,
    () => session.data.value?.session.id,
    () => session.status.value === "signing-out",
  ],
  () => {
    generation++
    busy.value = false
    message.value = ""
  },
  { flush: "sync" },
)
async function consent(accept: boolean) {
  if (busy.value || !client.value) return
  const continuation = inspectLoginContinuationLocation(
    window.location.pathname + window.location.search,
  )
  if (continuation.status !== "current") {
    message.value = "授权已失效，请返回调用应用重新发起。"
    return
  }
  const ownGeneration = generation
  const handleCredentialFailure = session.captureCredentialFailureHandler()
  busy.value = true
  try {
    const result = await authClient.oauth2.consent({
      accept,
      oauth_query: new URL(
        continuation.callbackLocation,
        window.location.origin,
      ).search.slice(1),
    })
    if (generation !== ownGeneration) return
    if (result.error) throw result.error
    redirectAuthenticationResult(result.data)
  } catch (error) {
    if (generation !== ownGeneration) return
    handleCredentialFailure(error)
    message.value = isInvalidOAuthContinuationError(error)
      ? "授权已失效，请返回调用应用重新发起。"
      : "授权未完成，请重试。"
    if (isInvalidOAuthContinuationError(error))
      window.history.replaceState(null, "", "/oauth/consent")
  } finally {
    if (generation === ownGeneration) busy.value = false
  }
}
</script>
<template>
  <SessionBoundary
    ><section class="panel">
      <h1>应用授权</h1>
      <p>
        {{ client?.name ?? "未知应用" }} 请求以下权限：{{
          scopes.join("、") || "未指定"
        }}。可随时在“已授权应用”中撤销离线授权。
      </p>
      <p role="alert">{{ message }}</p>
      <button
        class="pressable"
        :disabled="busy || !client"
        @click="consent(true)"
      >
        允许授权</button
      ><button
        class="pressable"
        :disabled="busy || !client"
        @click="consent(false)"
      >
        拒绝
      </button>
    </section></SessionBoundary
  >
</template>

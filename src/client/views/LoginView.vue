<script setup lang="ts">
import { computed, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import { useSession } from "../composables/session"
const session = useSession()
const route = useRoute()
const router = useRouter()
watch(
  () => session.status.value,
  (value) => {
    if (value === "authenticated" && !route.query.sig)
      void router.replace("/security/passkeys")
  },
)
const errorMessage = computed(() =>
  route.query.error === "invalid_signature"
    ? "授权已失效，请返回调用应用重新发起。你仍可直接登录管理后台。"
    : route.query.error
      ? "登录未完成，请重新发起。只有已指定的账号可以访问。"
      : "",
)
</script>

<template>
  <section class="panel login-panel">
    <p class="eyebrow">你的身份与访问控制</p>
    <h1>登录 eruoo</h1>
    <p>在一个地方管理登录方式、应用授权与自动化凭证。</p>
    <p v-if="errorMessage || session.message.value" class="notice" role="alert">
      {{ errorMessage || session.message.value }}
    </p>
    <button
      class="primary"
      :disabled="session.status.value === 'authenticating'"
      @click="session.signInPasskey"
    >
      使用 Passkey 登录
    </button>
    <button
      :disabled="session.status.value === 'authenticating'"
      @click="session.signIn"
    >
      使用 GitHub 登录
    </button>
    <RouterLink v-if="session.data.value" to="/">返回控制台</RouterLink>
  </section>
</template>

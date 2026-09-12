<script setup lang="ts">
import { computed } from "vue"

import { useSession } from "../../composables/session"
const session = useSession()
const pending = computed(() =>
  ["checking", "refreshing"].includes(session.status.value),
)
</script>

<template>
  <div v-if="session.message.value" class="notice" role="alert">
    {{ session.message.value }}
    <button class="pressable" @click="session.refresh(true)">重试检查</button>
    <button
      class="pressable"
      v-if="session.data.value"
      @click="session.signOut"
    >
      重试退出
    </button>
  </div>
  <p v-if="session.status.value === 'checking'" role="status">
    正在确认登录状态…
  </p>
  <fieldset
    v-if="session.data.value"
    :disabled="session.status.value !== 'authenticated'"
    :aria-busy="pending"
  >
    <slot />
  </fieldset>
  <section v-else-if="session.status.value === 'anonymous'" class="panel">
    <h2>请先登录</h2>
    <p>使用 Passkey 或 GitHub 访问管理控制台。</p>
    <button class="pressable" @click="session.signInPasskey">
      使用 Passkey 登录
    </button>
    <button class="primary pressable" @click="session.signIn">
      使用 GitHub 登录
    </button>
  </section>
</template>

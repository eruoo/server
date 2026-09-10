<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import BackupStatus from "../components/security/BackupStatus.vue"
import { useSession } from "../composables/session"
const session = useSession()
</script>

<template>
  <SessionBoundary>
    <section class="panel">
      <p class="eyebrow">账号</p>
      <h1>{{ session.data.value?.user.name }}</h1>
      <p>{{ session.data.value?.user.email }}</p>
      <p>正常使用时会自动延长登录有效期。敏感操作仍会要求重新验证身份。</p>
      <button @click="session.signOut">退出当前登录</button>
    </section>
    <BackupStatus />
  </SessionBoundary>
</template>

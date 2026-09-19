<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import AiInvocationsPanel from "../features/ai/AiInvocationsPanel.vue"
</script>
<template>
  <SessionBoundary><AiInvocationsPanel /></SessionBoundary>
</template>

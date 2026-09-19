<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import AiConnectionsPanel from "../features/ai/AiConnectionsPanel.vue"
</script>
<template>
  <SessionBoundary><AiConnectionsPanel /></SessionBoundary>
</template>

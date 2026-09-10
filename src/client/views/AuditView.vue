<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import AuditPanel from "../features/audit/AuditPanel.vue"
</script>
<template>
  <SessionBoundary><AuditPanel /></SessionBoundary>
</template>

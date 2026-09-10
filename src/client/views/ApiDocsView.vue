<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import ApiDocumentation from "../features/security/ApiDocumentation.vue"
</script>
<template>
  <SessionBoundary><ApiDocumentation /></SessionBoundary>
</template>

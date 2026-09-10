<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import ApiKeyPanel from "../features/security/ApiKeyPanel.vue"
</script>
<template>
  <SessionBoundary><ApiKeyPanel /></SessionBoundary>
</template>

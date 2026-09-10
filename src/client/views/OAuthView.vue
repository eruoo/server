<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import OAuthPanel from "../features/security/OAuthPanel.vue"
</script>
<template>
  <SessionBoundary><OAuthPanel /></SessionBoundary>
</template>

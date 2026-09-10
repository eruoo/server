<script setup lang="ts">
import SessionBoundary from "../components/auth/SessionBoundary.vue"
import PasskeyPanel from "../features/security/PasskeyPanel.vue"
</script>
<template>
  <SessionBoundary><PasskeyPanel /></SessionBoundary>
</template>

<script setup lang="ts">
import AppShell from "@client/components/layout/AppShell.vue"
import AuthorizedApplicationsPanel from "@client/features/security/AuthorizedApplicationsPanel.vue"
</script>

<template>
  <AppShell>
    <AuthorizedApplicationsPanel />
  </AppShell>
</template>

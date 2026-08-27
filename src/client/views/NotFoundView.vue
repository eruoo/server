<script setup lang="ts">
import AppShell from "@client/components/layout/AppShell.vue"
import { ArrowLeft } from "@lucide/vue"
import { RouterLink } from "vue-router"
</script>

<template>
  <AppShell>
    <section class="not-found" aria-labelledby="not-found-title">
      <p class="eyebrow">404 · NOT FOUND</p>
      <h1 id="not-found-title" data-route-heading tabindex="-1">页面不存在</h1>
      <p class="not-found-copy">这个管理页面不存在，或地址已经发生变化。</p>
      <RouterLink class="home-link pressable focus-ring" to="/">
        <ArrowLeft :size="18" aria-hidden="true" />
        返回访问管理
      </RouterLink>
    </section>
  </AppShell>
</template>

<style scoped>
.not-found {
  max-width: 44rem;
  padding-block: clamp(var(--spacing-10), 12vw, var(--spacing-20));
}

.eyebrow {
  margin: 0 0 var(--spacing-3);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(var(--text-4xl), 10vw, var(--text-6xl));
  line-height: var(--leading-tight);
}

.not-found-copy {
  margin-block: var(--spacing-5) var(--spacing-8);
  color: var(--text-secondary);
  font-size: var(--text-lg);
  line-height: var(--leading-relaxed);
}

.home-link {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  justify-content: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-3) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--accent-primary);
  box-shadow: var(--shadow-hard-sm);
  color: var(--accent-contrast);
  font-weight: var(--font-weight-bold);
  text-decoration: none;
}

.home-link:hover {
  background: var(--accent-primary-hover);
  color: var(--accent-contrast-hover);
}

.home-link:active {
  background: var(--accent-primary-active);
  color: var(--accent-contrast-active);
}
</style>

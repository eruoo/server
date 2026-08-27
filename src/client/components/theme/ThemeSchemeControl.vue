<script setup lang="ts">
import type { ThemeScheme } from "@client/composables/useTheme"
import { Monitor, Moon, Sun } from "@lucide/vue"
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui"

const props = defineProps<{
  scheme: ThemeScheme
}>()

const emit = defineEmits<{
  select: [scheme: ThemeScheme]
}>()

function selectScheme(value: unknown): void {
  if (value === "system" || value === "light" || value === "dark") {
    emit("select", value)
  }
}
</script>

<template>
  <ToggleGroupRoot
    class="theme-control"
    type="single"
    orientation="horizontal"
    :model-value="props.scheme"
    aria-label="主题模式"
    @update:model-value="selectScheme"
  >
    <ToggleGroupItem
      class="theme-option focus-ring"
      value="system"
      aria-label="跟随系统主题"
      title="跟随系统主题"
    >
      <Monitor :size="16" aria-hidden="true" />
      <span>系统</span>
    </ToggleGroupItem>
    <ToggleGroupItem
      class="theme-option focus-ring"
      value="light"
      aria-label="使用浅色主题"
      title="使用浅色主题"
    >
      <Sun :size="16" aria-hidden="true" />
      <span>浅色</span>
    </ToggleGroupItem>
    <ToggleGroupItem
      class="theme-option focus-ring"
      value="dark"
      aria-label="使用深色主题"
      title="使用深色主题"
    >
      <Moon :size="16" aria-hidden="true" />
      <span>深色</span>
    </ToggleGroupItem>
  </ToggleGroupRoot>
</template>

<style scoped>
.theme-control {
  display: inline-flex;
  padding: var(--spacing-1);
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--surface-subtle);
}

.theme-option {
  display: inline-flex;
  gap: var(--spacing-1);
  align-items: center;
  justify-content: center;
  min-height: calc(var(--touch-target-min) - var(--spacing-2));
  padding: var(--spacing-1) var(--spacing-2);
  border: var(--border-width-thin) solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
}

.theme-option:hover {
  background: var(--app-highlighted);
  color: var(--text-primary);
}

.theme-option[data-state="on"] {
  border-color: var(--border-default);
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

@media (width < 48rem) {
  .theme-option span {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
}
</style>

<script setup lang="ts">
import { computed } from "vue"

import type { ThemePreference } from "../../composables/theme"

const preference = defineModel<ThemePreference>({ required: true })
const options: Record<
  ThemePreference,
  { label: string; next: ThemePreference }
> = {
  light: { label: "浅色", next: "dark" },
  dark: { label: "深色", next: "system" },
  system: { label: "跟随系统", next: "light" },
}
const current = computed(() => options[preference.value])
const buttonLabel = computed(
  () =>
    `外观：${current.value.label}；切换为${options[current.value.next].label}`,
)
function cycleTheme() {
  preference.value = current.value.next
}
</script>

<template>
  <button
    type="button"
    class="icon-button pressable"
    :aria-label="buttonLabel"
    :title="buttonLabel"
    @click="cycleTheme"
  >
    <svg
      class="control-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="preference === 'light'">
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"
        />
      </template>
      <path
        v-else-if="preference === 'dark'"
        d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"
      />
      <template v-else>
        <rect x="3" y="3" width="18" height="13" rx="1" />
        <path d="M12 16v5m-4 0h8" />
      </template>
    </svg>
  </button>
</template>

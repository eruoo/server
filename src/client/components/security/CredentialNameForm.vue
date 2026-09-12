<script setup lang="ts">
import { shallowRef } from "vue"
defineProps<{ busy: boolean; label: string }>()
const emit = defineEmits<{ submit: [name: string] }>()
const name = shallowRef("")
function submit() {
  const value = name.value.trim()
  if (value) emit("submit", value)
}
</script>
<template>
  <form class="name-form" @submit.prevent="submit">
    <label
      >名称<input
        v-model="name"
        required
        maxlength="100"
        placeholder="例如：我的电脑"
        :disabled="busy" /></label
    ><button class="primary pressable" :disabled="busy || !name.trim()">
      {{ label }}
    </button>
  </form>
</template>

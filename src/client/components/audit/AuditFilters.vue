<script setup lang="ts">
import { reactive } from "vue"
defineProps<{ busy: boolean }>()
const filters = reactive({ outcome: "", from: "", to: "" })
const emit = defineEmits<{
  apply: [filters: { outcome: string; from: string; to: string }]
}>()
</script>
<template>
  <form class="actions" @submit.prevent="emit('apply', { ...filters })">
    <label
      >结果<select v-model="filters.outcome">
        <option value="">全部</option>
        <option value="success">成功</option>
        <option value="failure">失败</option>
      </select></label
    >
    <label>起始时间<input v-model="filters.from" type="datetime-local" /></label
    ><label>结束时间<input v-model="filters.to" type="datetime-local" /></label
    ><button class="pressable" :disabled="busy">筛选</button>
  </form>
</template>

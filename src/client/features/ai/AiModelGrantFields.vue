<script setup lang="ts">
import { computed } from "vue"

import { readAiModelCapabilities, type AiConnection } from "./ai-connections"

const props = defineProps<{
  connections: readonly AiConnection[]
  connectionId: string
  modelIds: readonly string[]
  disabled: boolean
}>()
const emit = defineEmits<{
  "update:connectionId": [value: string]
  "update:modelIds": [value: string[]]
}>()
const connection = computed(() =>
  props.connections.find((entry) => entry.id === props.connectionId),
)
const availableModels = computed(() =>
  connection.value?.enabled &&
  connection.value.authorizationStatus === "connected"
    ? connection.value.models.filter(
        (model) => readAiModelCapabilities(model.capabilities).supportedInApi,
      )
    : [],
)
function chooseConnection(event: Event) {
  emit("update:connectionId", (event.target as HTMLSelectElement).value)
  emit("update:modelIds", [])
}
function toggleModel(id: string) {
  emit(
    "update:modelIds",
    props.modelIds.includes(id)
      ? props.modelIds.filter((value) => value !== id)
      : [...props.modelIds, id],
  )
}
</script>

<template>
  <fieldset
    class="model-grants"
    :disabled="disabled"
    data-testid="ai-model-grants"
  >
    <legend>连接与模型许可</legend>
    <label
      >AI 连接
      <select
        :value="connectionId"
        data-testid="key-connection"
        @change="chooseConnection"
      >
        <option value="" disabled>请选择连接</option>
        <option
          v-if="connectionId && !connection"
          :value="connectionId"
          disabled
        >
          原连接已不可用，请重新选择
        </option>
        <option
          v-for="entry in connections"
          :key="entry.id"
          :value="entry.id"
          :disabled="
            !entry.enabled || entry.authorizationStatus !== 'connected'
          "
        >
          {{ entry.name }} · {{ entry.id.slice(0, 8)
          }}{{
            !entry.enabled || entry.authorizationStatus !== "connected"
              ? "（不可用）"
              : ""
          }}
        </option>
      </select>
    </label>
    <p>此密钥通过所选连接调用模型；请求中直接填写下列模型名。</p>
    <p v-if="availableModels.length === 0">
      暂无可选模型：请选择已启用、已保存 Key 并成功发现模型的连接。
    </p>
    <button
      v-if="modelIds.length"
      type="button"
      class="pressable"
      @click="emit('update:modelIds', [])"
    >
      取消全部模型许可
    </button>
    <label
      v-for="model in availableModels"
      :key="model.id"
      class="model-choice"
    >
      <input
        type="checkbox"
        :checked="modelIds.includes(model.id)"
        @change="toggleModel(model.id)"
      />
      {{ model.id }}
    </label>
  </fieldset>
</template>

<style scoped>
.model-choice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.model-choice input {
  width: auto;
  min-height: auto;
  flex: none;
}
</style>

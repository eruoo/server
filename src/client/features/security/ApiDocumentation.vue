<script setup lang="ts">
import { ApiReference } from "@scalar/api-reference"
import { inject, onMounted, onUnmounted, shallowRef } from "vue"

import "@scalar/api-reference/style.css"
import "../../styles/api-reference.css"
import { useSession } from "../../composables/session"
import { darkThemeKey } from "../../composables/theme"
import { requestJson } from "../../lib/http"
const session = useSession()
const isDark = inject(darkThemeKey)
const content = shallowRef<string>()
const message = shallowRef("")
const busy = shallowRef(false)
let controller: AbortController | undefined
const configuration: NonNullable<
  InstanceType<typeof ApiReference>["$props"]["configuration"]
> = {
  agent: { disabled: true },
  mcp: { disabled: true },
  persistAuth: false,
  telemetry: false,
  hideTestRequestButton: true,
  hideClientButton: true,
  showDeveloperTools: "never",
  isEditable: false,
  withDefaultFonts: false,
  theme: "none",
  hideDarkModeToggle: true,
}
async function load() {
  if (busy.value) return
  const handleCredentialFailure = session.captureCredentialFailureHandler()
  busy.value = true
  message.value = ""
  controller = new AbortController()
  const current = controller
  try {
    const document = await requestJson<unknown>("/api/openapi.json", {
      signal: current.signal,
    })
    if (!current.signal.aborted) content.value = JSON.stringify(document)
  } catch (error) {
    if (!current.signal.aborted) {
      handleCredentialFailure(error)
      message.value = "API 文档未加载，请重试。"
    }
  } finally {
    if (!current.signal.aborted) busy.value = false
  }
}
onMounted(load)
onUnmounted(() => {
  controller?.abort()
  content.value = undefined
})
</script>
<template>
  <h1>API 文档</h1>
  <p v-if="busy" role="status">正在读取契约…</p>
  <p v-if="message" role="alert">
    {{ message }} <button class="pressable" @click="load">重试</button>
  </p>
  <div v-if="content" class="api-reference">
    <ApiReference
      :configuration="{ ...configuration, content, darkMode: isDark }"
    />
  </div>
</template>

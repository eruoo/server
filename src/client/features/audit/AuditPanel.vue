<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue"

import AuditFilters from "../../components/audit/AuditFilters.vue"
import AuditList from "../../components/audit/AuditList.vue"
import { useSession } from "../../composables/session"
import { getAuditEvents, type AuditEvent } from "./service"
const session = useSession()
const events = shallowRef<AuditEvent[]>([])
const busy = shallowRef(false)
const message = shallowRef("")
const nextCursor = shallowRef<string | null>(null)
let filters = { outcome: "", from: "", to: "" }
let generation = 0
let controller: AbortController | undefined
async function load(append = false) {
  const ownGeneration = ++generation
  const handleCredentialFailure = session.captureCredentialFailureHandler()
  controller?.abort()
  controller = new AbortController()
  busy.value = true
  message.value = ""
  try {
    const page = await getAuditEvents(
      filters,
      append ? nextCursor.value : null,
      controller.signal,
    )
    if (generation !== ownGeneration) return
    events.value = append ? [...events.value, ...page.events] : page.events
    nextCursor.value = page.nextCursor
  } catch (error) {
    if (generation === ownGeneration) {
      handleCredentialFailure(error)
      message.value = "审计记录未加载，请重试。"
    }
  } finally {
    if (generation === ownGeneration) busy.value = false
  }
}
function apply(value: typeof filters) {
  filters = value
  events.value = []
  nextCursor.value = null
  void load()
}
onMounted(() => load())
onUnmounted(() => {
  generation++
  controller?.abort()
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">安全记录</p>
    <h1>安全审计</h1>
    <p>查看最近 180 天的登录与凭证操作。</p>
    <AuditFilters :busy="busy" @apply="apply" />
    <p v-if="message" role="alert">
      {{ message }}<button @click="load()">重试</button>
    </p>
    <AuditList :events="events" /><button
      v-if="nextCursor"
      :disabled="busy"
      @click="load(true)"
    >
      加载更多
    </button>
    <p v-if="busy" role="status">正在读取…</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from "vue"

import type { DatabaseBackupStatus } from "../../../shared/backup"
import { useSession } from "../../composables/session"
import { requestJson } from "../../lib/http"
const session = useSession()
const data = shallowRef<DatabaseBackupStatus>()
const busy = shallowRef(false)
const message = shallowRef("")
let controller: AbortController | undefined
const stale = computed(
  () =>
    !data.value?.lastSuccessAt ||
    Date.now() - data.value.lastSuccessAt > 26 * 60 * 60 * 1000,
)
async function refresh() {
  if (busy.value || session.status.value !== "authenticated") return
  const handleCredentialFailure = session.captureCredentialFailureHandler()
  busy.value = true
  message.value = ""
  controller = new AbortController()
  const current = controller
  try {
    const result = await requestJson<DatabaseBackupStatus>(
      "/api/security/backup-status",
      { signal: current.signal },
    )
    if (!current.signal.aborted) data.value = result
  } catch (error) {
    if (!current.signal.aborted) {
      handleCredentialFailure(error)
      message.value = "暂时无法读取备份状态，请重试。"
    }
  } finally {
    if (!current.signal.aborted) busy.value = false
  }
}
onMounted(refresh)
onUnmounted(() => controller?.abort())
</script>
<template>
  <div class="backup-status" :aria-busy="busy">
    <button
      type="button"
      class="pressable"
      :disabled="busy || session.status.value !== 'authenticated'"
      @click="refresh"
    >
      {{ busy ? "正在读取…" : "刷新备份状态" }}
    </button>
    <p role="status">{{ message }}</p>
    <template v-if="data">
      <p v-if="data.status === 'never-run'" role="alert">尚无备份记录。</p>
      <p v-else-if="data.status === 'failed'" role="alert">
        最近一次备份失败：{{ data.errorCode }}
      </p>
      <p v-if="stale" role="alert">
        尚无 26 小时内的成功备份，请检查备份任务。
      </p>
      <p v-if="data.lastSuccessAt">
        最近成功：{{ new Date(data.lastSuccessAt).toLocaleString() }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue"

import { useSession } from "../../composables/session"
import { ApiError } from "../../lib/http"
import type { AiInvocationCursor, AiInvocationRecord } from "./ai-invocations"
import {
  describeAiInvocationError,
  listAiInvocations,
  readUsageTotalTokens,
} from "./ai-invocations"

const session = useSession()
const records = shallowRef<AiInvocationRecord[]>([])
const cursor = shallowRef<AiInvocationCursor | null>(null)
const busy = shallowRef(false)
const message = shallowRef("")
const needsReauthentication = shallowRef(false)
let reader: AbortController | undefined
let disposed = false

async function load(more = false) {
  if (busy.value || disposed) return
  const handleCredentialFailure = session.captureCredentialFailureHandler()
  reader?.abort()
  reader = new AbortController()
  busy.value = true
  message.value = ""
  try {
    const page = await listAiInvocations(
      reader.signal,
      more ? (cursor.value ?? undefined) : undefined,
    )
    if (disposed) return
    records.value = more ? [...records.value, ...page.records] : page.records
    cursor.value = page.nextCursor
  } catch (error) {
    if (disposed || (error instanceof Error && error.name === "AbortError"))
      return
    if (handleCredentialFailure(error)) {
      needsReauthentication.value = true
      message.value = "需要重新验证身份。"
      return
    }
    message.value =
      error instanceof ApiError ? error.message : "调用记录未加载，请重试。"
  } finally {
    if (!disposed) busy.value = false
  }
}

function formatTime(value: number | null): string {
  return value === null ? "—" : new Date(value).toLocaleString()
}

onMounted(() => load())
onUnmounted(() => {
  disposed = true
  reader?.abort()
})
</script>
<template>
  <section class="panel">
    <p class="eyebrow">AI 接入</p>
    <h1>调用记录</h1>
    <p>
      仅记录调用元数据（状态、受控错误码、时间与上游用量），不保存输入、输出、图片或令牌。
    </p>
    <p role="status">{{ message }}</p>
    <template v-if="needsReauthentication"
      ><button class="pressable" @click="session.signInPasskey">
        使用 Passkey 重新验证</button
      ><button class="pressable" @click="session.signIn">
        使用 GitHub 重新验证
      </button></template
    >
    <p v-if="!busy && records.length === 0">最近 30 天没有调用记录。</p>
    <ul class="credential-list">
      <li v-for="record in records" :key="record.requestId">
        <h2>
          {{ record.effectiveStatus }} ·
          {{ record.upstreamModelId ?? "模型未识别" }}
        </h2>
        <p>
          {{ formatTime(record.startedAt) }} → {{ formatTime(record.endedAt) }}
        </p>
        <p>
          请求 {{ record.requestId.slice(0, 8) }}… ·
          {{
            record.upstreamRequestId
              ? `上游 ${record.upstreamRequestId}`
              : "上游请求号未知"
          }}
        </p>
        <p>
          <span data-testid="ai-invocation-error">{{
            describeAiInvocationError(record.errorCode)
          }}</span>
          ·
          <template v-if="readUsageTotalTokens(record.usage) !== null"
            >用量 {{ readUsageTotalTokens(record.usage) }} tokens</template
          ><template v-else>用量未知</template>
        </p>
      </li>
    </ul>
    <button
      v-if="cursor"
      class="pressable"
      :disabled="busy"
      @click="load(true)"
    >
      加载更多
    </button>
    <button class="pressable" :disabled="busy" @click="load()">刷新列表</button>
  </section>
</template>

<script setup lang="ts">
import type { AuditEvent } from "../../features/audit/service"
defineProps<{ events: readonly AuditEvent[] }>()
</script>
<template>
  <p v-if="!events.length" class="empty">此范围内没有安全事件。</p>
  <div
    v-else
    class="table-scroll"
    role="region"
    aria-label="安全事件列表"
    tabindex="0"
  >
    <table>
      <thead>
        <tr>
          <th>时间</th>
          <th>事件</th>
          <th>结果</th>
          <th>请求标识</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="event in events" :key="event.id">
          <td>{{ new Date(event.occurredAt).toLocaleString() }}</td>
          <td>{{ event.type }}</td>
          <td>{{ event.outcome === "success" ? "成功" : "失败" }}</td>
          <td>
            <code>{{ event.requestId }}</code>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

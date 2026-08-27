<script setup lang="ts">
import {
  auditEventTypeLabels,
  auditOutcomeLabels,
  type SecurityAuditEvent,
} from "@client/features/security/audit-events-service"
import {
  formatAuditMetadata,
  formatAuditTimestamp,
} from "@client/features/security/audit-log-model"

defineProps<{
  events: readonly SecurityAuditEvent[]
}>()

function hasMetadata(event: SecurityAuditEvent): boolean {
  return event.metadata !== null && Object.keys(event.metadata).length > 0
}
</script>

<template>
  <ol class="audit-event-list" aria-label="安全审计事件">
    <li v-for="event in events" :key="event.id" class="audit-event-card">
      <div class="event-heading">
        <div>
          <p class="event-type-code">{{ event.type }}</p>
          <h2>{{ auditEventTypeLabels[event.type] }}</h2>
        </div>
        <span class="outcome-badge" :class="`outcome-${event.outcome}`">
          {{ auditOutcomeLabels[event.outcome] }}
        </span>
      </div>

      <time :datetime="new Date(event.occurredAt).toISOString()">
        {{ formatAuditTimestamp(event.occurredAt) }}
      </time>

      <details class="event-details">
        <summary class="focus-ring">查看事件详情</summary>
        <dl>
          <div>
            <dt>Request ID</dt>
            <dd>
              <code>{{ event.requestId }}</code>
            </dd>
          </div>
          <div>
            <dt>Event ID</dt>
            <dd>
              <code>{{ event.id }}</code>
            </dd>
          </div>
          <div v-if="event.subjectId !== null">
            <dt>Subject ID</dt>
            <dd>
              <code>{{ event.subjectId }}</code>
            </dd>
          </div>
          <div v-if="event.clientId !== null">
            <dt>Client ID</dt>
            <dd>
              <code>{{ event.clientId }}</code>
            </dd>
          </div>
          <div v-if="event.credentialId !== null">
            <dt>Credential ID</dt>
            <dd>
              <code>{{ event.credentialId }}</code>
            </dd>
          </div>
          <div v-if="event.ipFingerprint !== null">
            <dt>IP 指纹</dt>
            <dd>
              <code>{{ event.ipFingerprint }}</code>
            </dd>
          </div>
        </dl>

        <div v-if="hasMetadata(event)" class="metadata-block">
          <h3>元数据</h3>
          <pre><code>{{ formatAuditMetadata(event.metadata ?? {}) }}</code></pre>
        </div>
      </details>
    </li>
  </ol>
</template>

<style scoped>
.audit-event-list {
  display: grid;
  gap: var(--spacing-4);
  padding: 0;
  margin: 0;
  list-style: none;
}

.audit-event-card {
  display: grid;
  gap: var(--spacing-3);
  padding: clamp(var(--spacing-4), 4vw, var(--spacing-6));
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-hard-sm);
}

.event-heading {
  display: flex;
  gap: var(--spacing-4);
  align-items: flex-start;
  justify-content: space-between;
}

.event-type-code {
  margin: 0 0 var(--spacing-1);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

h2,
h3 {
  margin: 0;
  font-family: var(--font-display);
  font-weight: var(--font-weight-bold);
}

h2 {
  font-size: var(--text-xl);
}

h3 {
  font-size: var(--text-base);
}

.outcome-badge {
  flex: none;
  padding: var(--spacing-1) var(--spacing-2);
  border: var(--border-width-control) solid currentColor;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
}

.outcome-success {
  background: var(--status-success-bg);
  color: var(--status-success-fg);
}

.outcome-failure {
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

time {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.event-details {
  border-top: var(--border-width-thin) solid var(--border-default);
  padding-block-start: var(--spacing-3);
}

summary {
  width: fit-content;
  cursor: pointer;
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
}

dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-3);
  margin-block: var(--spacing-4);
}

dl div {
  min-width: 0;
}

dt {
  margin-block-end: var(--spacing-1);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.metadata-block {
  display: grid;
  gap: var(--spacing-2);
}

pre {
  max-width: 100%;
  padding: var(--spacing-3);
  margin: 0;
  overflow: auto;
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--surface-subtle);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

@media (width < 44rem) {
  dl {
    grid-template-columns: 1fr;
  }
}
</style>

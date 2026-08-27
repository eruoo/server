<script setup lang="ts">
import {
  auditEventTypeLabels,
  auditOutcomeLabels,
  type AuditEventFilters,
  type AuditEventType,
  type AuditOutcome,
} from "@client/features/security/audit-events-service"
import {
  defaultAuditFilterDraft,
  normalizeAuditFilterDraft,
  type AuditFilterDraft,
  type AuditPageSize,
} from "@client/features/security/audit-log-model"
import { RotateCcw, Search } from "@lucide/vue"
import { shallowRef } from "vue"

defineProps<{
  disabled: boolean
}>()

const emit = defineEmits<{
  apply: [filters: AuditEventFilters]
}>()

const eventTypeOptions = Object.entries(auditEventTypeLabels).map(
  ([value, label]) => ({ label, value: value as AuditEventType }),
)
const outcomeOptions = Object.entries(auditOutcomeLabels).map(
  ([value, label]) => ({ label, value: value as AuditOutcome }),
)
const pageSizes = [25, 50, 100] as const satisfies readonly AuditPageSize[]

const from = shallowRef(defaultAuditFilterDraft.from)
const limit = shallowRef(defaultAuditFilterDraft.limit)
const outcome = shallowRef<AuditFilterDraft["outcome"]>(
  defaultAuditFilterDraft.outcome,
)
const to = shallowRef(defaultAuditFilterDraft.to)
const type = shallowRef<AuditFilterDraft["type"]>(defaultAuditFilterDraft.type)
const filterError = shallowRef<string>()

function currentDraft(): AuditFilterDraft {
  return {
    from: from.value,
    limit: limit.value,
    outcome: outcome.value,
    to: to.value,
    type: type.value,
  }
}

function applyFilters(): void {
  const filters = normalizeAuditFilterDraft(currentDraft())

  if (filters === undefined) {
    filterError.value = "请输入有效的上海时间，并确保开始时间不晚于结束时间。"
    return
  }

  filterError.value = undefined
  emit("apply", filters)
}

function resetFilters(): void {
  from.value = defaultAuditFilterDraft.from
  limit.value = defaultAuditFilterDraft.limit
  outcome.value = defaultAuditFilterDraft.outcome
  to.value = defaultAuditFilterDraft.to
  type.value = defaultAuditFilterDraft.type
  filterError.value = undefined
  applyFilters()
}
</script>

<template>
  <form
    class="audit-filters"
    :aria-describedby="filterError ? 'audit-filter-error' : undefined"
    @submit.prevent="applyFilters"
  >
    <fieldset :disabled="disabled">
      <legend>筛选安全事件</legend>

      <div class="filter-grid">
        <label class="filter-field">
          <span>事件类型</span>
          <select v-model="type" class="filter-control focus-ring">
            <option value="">全部类型</option>
            <option
              v-for="option in eventTypeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>

        <label class="filter-field">
          <span>结果</span>
          <select v-model="outcome" class="filter-control focus-ring">
            <option value="">全部结果</option>
            <option
              v-for="option in outcomeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>

        <label class="filter-field">
          <span>开始时间</span>
          <input
            v-model="from"
            class="filter-control focus-ring"
            type="datetime-local"
            min="1970-01-01T08:00"
            step="60"
          />
        </label>

        <label class="filter-field">
          <span>结束时间</span>
          <input
            v-model="to"
            class="filter-control focus-ring"
            type="datetime-local"
            min="1970-01-01T08:00"
            step="60"
          />
        </label>

        <label class="filter-field page-size-field">
          <span>每页条数</span>
          <select v-model.number="limit" class="filter-control focus-ring">
            <option v-for="size in pageSizes" :key="size" :value="size">
              {{ size }} 条
            </option>
          </select>
        </label>
      </div>

      <p class="timezone-note">时间筛选按 Asia/Shanghai（UTC+8）解释。</p>

      <p
        v-if="filterError"
        id="audit-filter-error"
        class="filter-error"
        role="alert"
      >
        {{ filterError }}
      </p>

      <div class="filter-actions">
        <button class="primary-button focus-ring" type="submit">
          <Search :size="18" aria-hidden="true" />
          应用筛选
        </button>
        <button
          class="secondary-button focus-ring"
          type="button"
          @click="resetFilters"
        >
          <RotateCcw :size="18" aria-hidden="true" />
          重置
        </button>
      </div>
    </fieldset>
  </form>
</template>

<style scoped>
.audit-filters {
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-panel);
  box-shadow: var(--shadow-hard-sm);
}

fieldset {
  display: grid;
  gap: var(--spacing-4);
  padding: clamp(var(--spacing-4), 4vw, var(--spacing-6));
  margin: 0;
  border: 0;
}

legend {
  padding: 0 var(--spacing-2);
  font-family: var(--font-display);
  font-size: var(--text-xl);
  font-weight: var(--font-weight-bold);
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-4);
}

.filter-field {
  display: grid;
  gap: var(--spacing-2);
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
}

.filter-control {
  width: 100%;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-3);
  border: var(--border-width-control) solid var(--border-default);
  border-radius: 0;
  background: var(--surface-elevated);
  color: var(--text-primary);
  font: inherit;
}

.filter-control:disabled {
  cursor: wait;
  opacity: 0.6;
}

.page-size-field {
  max-width: 12rem;
}

.timezone-note,
.filter-error {
  margin: 0;
  font-size: var(--text-sm);
}

.timezone-note {
  color: var(--text-secondary);
}

.filter-error {
  padding: var(--spacing-3);
  border: var(--border-width-control) solid var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
  font-weight: var(--font-weight-bold);
}

.filter-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-3);
}

.primary-button,
.secondary-button {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
}

.primary-button {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  box-shadow: var(--shadow-hard-sm);
}

.secondary-button {
  background: var(--surface-elevated);
  color: var(--text-primary);
}

.primary-button:active,
.secondary-button:active {
  box-shadow: none;
  transform: translate(2px, 2px);
}

@media (width < 44rem) {
  .filter-grid {
    grid-template-columns: 1fr;
  }
}
</style>

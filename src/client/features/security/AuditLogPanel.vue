<script setup lang="ts">
import {
  auditEventsService,
  defaultAuditPageSize,
  type AuditEventFilters as AppliedAuditFilters,
  type AuditEventPage,
} from "@client/features/security/audit-events-service"
import AuditEventFilters from "@client/features/security/AuditEventFilters.vue"
import AuditEventList from "@client/features/security/AuditEventList.vue"
import { requiresAuthentication } from "@client/lib/auth-errors"
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText } from "@lucide/vue"
import { computed, nextTick, onMounted, shallowRef, useTemplateRef } from "vue"
import { RouterLink } from "vue-router"

type LoadState = "authentication-required" | "error" | "loading" | "ready"
type NavigationKind = "apply" | "next" | "previous" | "reload"

interface PageNavigation {
  cursor: string | undefined
  filters: AppliedAuditFilters
  kind: NavigationKind
}

const emptyPage: AuditEventPage = { events: [], nextCursor: null }
const defaultFilters: AppliedAuditFilters = { limit: defaultAuditPageSize }

const activeFilters = shallowRef<AppliedAuditFilters>(defaultFilters)
const currentCursor = shallowRef<string>()
const cursorHistory = shallowRef<readonly (string | undefined)[]>([])
const lastNavigation = shallowRef<PageNavigation>()
const loadState = shallowRef<LoadState>("loading")
const page = shallowRef<AuditEventPage>(emptyPage)
const resultsStatus = useTemplateRef<HTMLParagraphElement>("results-status")

const pageNumber = computed(() => cursorHistory.value.length + 1)

function pageRequest(navigation: PageNavigation) {
  return {
    ...navigation.filters,
    ...(navigation.cursor === undefined ? {} : { cursor: navigation.cursor }),
  }
}

function commitNavigation(navigation: PageNavigation): void {
  if (navigation.kind === "apply") {
    activeFilters.value = navigation.filters
    currentCursor.value = undefined
    cursorHistory.value = []
    return
  }

  if (navigation.kind === "next") {
    cursorHistory.value = [...cursorHistory.value, currentCursor.value]
    currentCursor.value = navigation.cursor
    return
  }

  if (navigation.kind === "previous") {
    cursorHistory.value = cursorHistory.value.slice(0, -1)
    currentCursor.value = navigation.cursor
  }
}

async function loadPage(navigation: PageNavigation): Promise<void> {
  lastNavigation.value = navigation
  loadState.value = "loading"
  page.value = emptyPage

  try {
    const loadedPage = await auditEventsService.list(pageRequest(navigation))
    page.value = loadedPage
    commitNavigation(navigation)
    loadState.value = "ready"

    if (navigation.kind !== "reload") {
      await nextTick()
      resultsStatus.value?.focus()
    }
  } catch (error) {
    page.value = emptyPage
    loadState.value = requiresAuthentication(error)
      ? "authentication-required"
      : "error"
  }
}

function applyFilters(filters: AppliedAuditFilters): void {
  void loadPage({ cursor: undefined, filters, kind: "apply" })
}

function loadNextPage(): void {
  if (loadState.value !== "ready" || page.value.nextCursor === null) return

  void loadPage({
    cursor: page.value.nextCursor,
    filters: activeFilters.value,
    kind: "next",
  })
}

function loadPreviousPage(): void {
  if (loadState.value !== "ready" || cursorHistory.value.length === 0) return

  void loadPage({
    cursor: cursorHistory.value.at(-1),
    filters: activeFilters.value,
    kind: "previous",
  })
}

function retryLastRequest(): void {
  if (lastNavigation.value === undefined) return
  void loadPage(lastNavigation.value)
}

onMounted(() => {
  void loadPage({ cursor: undefined, filters: defaultFilters, kind: "reload" })
})
</script>

<template>
  <section
    class="audit-log"
    aria-labelledby="audit-title"
    :aria-busy="loadState === 'loading'"
  >
    <header class="page-header">
      <div>
        <p class="eyebrow">SECURITY HISTORY</p>
        <h1 id="audit-title" data-route-heading tabindex="-1">安全审计</h1>
      </div>
      <ScrollText :size="38" stroke-width="2.25" aria-hidden="true" />
    </header>

    <p class="page-copy">
      查看最近 180 天的安全事件。事件时间统一按 Asia/Shanghai 显示，原始 IP
      不会被保存。
    </p>

    <AuditEventFilters
      :disabled="
        loadState === 'loading' || loadState === 'authentication-required'
      "
      @apply="applyFilters"
    />

    <div v-if="loadState === 'loading'" class="state-card" role="status">
      <span class="loading-mark" aria-hidden="true"></span>
      正在读取安全事件…
    </div>

    <div
      v-else-if="loadState === 'authentication-required'"
      class="state-card error-state"
      role="alert"
    >
      <div>
        <strong>Session 已失效。</strong>
        <p>重新登录后才能继续查看安全审计。</p>
      </div>
      <RouterLink class="secondary-button focus-ring" to="/login">
        重新登录
      </RouterLink>
    </div>

    <div
      v-else-if="loadState === 'error'"
      class="state-card error-state"
      role="alert"
    >
      <div>
        <strong>无法验证审计数据。</strong>
        <p>响应未通过安全校验或服务暂时不可用。</p>
      </div>
      <button
        class="secondary-button focus-ring"
        type="button"
        @click="retryLastRequest"
      >
        <RefreshCw :size="18" aria-hidden="true" />
        重试
      </button>
    </div>

    <div v-else-if="page.events.length === 0" class="state-card empty-state">
      当前筛选条件下没有安全事件。
    </div>

    <AuditEventList v-else :events="page.events" />

    <nav
      v-if="loadState === 'ready'"
      class="pagination"
      aria-label="审计日志分页"
    >
      <button
        class="secondary-button focus-ring"
        type="button"
        :disabled="cursorHistory.length === 0"
        @click="loadPreviousPage"
      >
        <ChevronLeft :size="18" aria-hidden="true" />
        上一页
      </button>
      <p
        ref="results-status"
        class="page-status focus-ring"
        tabindex="-1"
        aria-live="polite"
      >
        第 {{ pageNumber }} 页 · {{ page.events.length }} 条
      </p>
      <button
        class="secondary-button focus-ring"
        type="button"
        :disabled="page.nextCursor === null"
        @click="loadNextPage"
      >
        下一页
        <ChevronRight :size="18" aria-hidden="true" />
      </button>
    </nav>
  </section>
</template>

<style scoped>
.audit-log {
  display: grid;
  gap: var(--spacing-6);
  padding-block: clamp(var(--spacing-10), 8vw, var(--spacing-16));
}

.page-header,
.pagination {
  display: flex;
  gap: var(--spacing-4);
  align-items: center;
  justify-content: space-between;
}

.eyebrow {
  margin: 0 0 var(--spacing-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-widest);
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(var(--text-4xl), 9vw, 5.5rem);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--tracking-tight);
  line-height: 0.95;
}

.page-copy {
  max-width: 48rem;
  margin: 0;
  color: var(--text-secondary);
  line-height: var(--leading-relaxed);
}

.state-card {
  display: flex;
  gap: var(--spacing-3);
  align-items: center;
  min-height: 7rem;
  padding: var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-elevated);
  font-family: var(--font-mono);
}

.state-card p {
  margin: var(--spacing-1) 0 0;
  color: var(--text-secondary);
}

.error-state {
  justify-content: space-between;
  border-color: var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger-fg);
}

.empty-state {
  justify-content: center;
  text-align: center;
}

.loading-mark {
  width: var(--spacing-3);
  height: var(--spacing-3);
  border: var(--border-width-thin) solid var(--border-default);
  background: var(--status-warning-bg);
  animation: pulse 1s steps(2, end) infinite;
}

.secondary-button {
  display: inline-flex;
  gap: var(--spacing-2);
  align-items: center;
  min-height: var(--touch-target-min);
  padding: var(--spacing-2) var(--spacing-4);
  border: var(--border-width-control) solid var(--border-default);
  background: var(--surface-elevated);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-weight: var(--font-weight-bold);
}

.secondary-button:not(:disabled):active {
  transform: translate(2px, 2px);
}

.secondary-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.pagination {
  padding-block: var(--spacing-2);
}

.pagination p {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-bold);
  text-align: center;
}

@media (width < 36rem) {
  .pagination {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .pagination p {
    grid-column: 1 / -1;
    grid-row: 1;
  }
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
</style>

<script setup lang="ts">
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "reka-ui"
import { computed } from "vue"

import { useSession } from "../../composables/session"

const session = useSession()
const busy = computed(() =>
  ["checking", "refreshing", "authenticating", "signing-out"].includes(
    session.status.value,
  ),
)
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="account-trigger pressable"
        aria-label="账号菜单"
        :disabled="busy"
        :aria-busy="session.status.value === 'signing-out'"
      >
        <svg
          class="control-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </svg>
        <span>{{
          session.status.value === "signing-out" ? "正在退出…" : "账号"
        }}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="dropdown-content account-menu"
        align="end"
        :side-offset="12"
        :collision-padding="16"
        aria-label="账号菜单"
      >
        <DropdownMenuLabel class="account-details">
          <strong>{{ session.data.value?.user.name }}</strong>
          <span>{{ session.data.value?.user.email }}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator class="dropdown-separator" />
        <p
          v-if="session.status.value === 'unavailable' && session.message.value"
          role="alert"
        >
          {{ session.message.value }}
        </p>
        <DropdownMenuItem
          class="dropdown-item"
          :disabled="busy"
          @select.prevent="session.signOut"
        >
          {{
            session.status.value === "signing-out" ? "正在退出…" : "退出登录"
          }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

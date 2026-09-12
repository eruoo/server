<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "reka-ui"
import { shallowRef, watch } from "vue"
import { useRoute } from "vue-router"

import { useSession } from "../../composables/session"
import BackupStatus from "../security/BackupStatus.vue"

const session = useSession()
const route = useRoute()
const open = shallowRef(false)
watch(
  [() => route.fullPath, () => session.data.value?.session.id],
  () => (open.value = false),
)
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger as-child>
      <button
        type="button"
        class="footer-link"
        :disabled="session.status.value !== 'authenticated'"
      >
        备份状态
      </button>
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog-content">
        <DialogTitle>数据库备份</DialogTitle>
        <DialogDescription>每天自动备份，保留 30 天。</DialogDescription>
        <BackupStatus />
        <div class="actions">
          <DialogClose as-child>
            <button type="button" class="pressable">关闭</button>
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

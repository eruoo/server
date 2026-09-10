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
defineProps<{
  title: string
  description: string
  busy?: boolean
  actionLabel?: string
}>()
const emit = defineEmits<{ confirm: [] }>()
</script>
<template>
  <DialogRoot>
    <DialogTrigger as-child
      ><button :disabled="busy" class="danger">
        {{ actionLabel ?? "删除" }}
      </button></DialogTrigger
    >
    <DialogPortal
      ><DialogOverlay class="dialog-overlay" /><DialogContent
        class="dialog-content"
      >
        <DialogTitle>{{ title }}</DialogTitle
        ><DialogDescription>{{ description }}</DialogDescription>
        <div class="actions">
          <DialogClose as-child><button>取消</button></DialogClose
          ><DialogClose as-child
            ><button class="danger" :disabled="busy" @click="emit('confirm')">
              确认{{ actionLabel ?? "删除" }}
            </button></DialogClose
          >
        </div>
      </DialogContent></DialogPortal
    >
  </DialogRoot>
</template>

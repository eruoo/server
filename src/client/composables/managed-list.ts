import { onUnmounted, readonly, shallowRef } from "vue"

import { ApiError } from "../lib/http"
import { useSession } from "./session"

export function useManagedList<T>(read: (signal: AbortSignal) => Promise<T[]>) {
  const session = useSession()
  const items = shallowRef<T[]>([])
  const busy = shallowRef(false)
  const message = shallowRef("")
  const needsReauthentication = shallowRef(false)
  let generation = 0
  let reader: AbortController | undefined
  let disposed = false
  async function refresh() {
    reader?.abort()
    reader = new AbortController()
    const ownGeneration = ++generation
    const result = await read(reader.signal)
    if (!disposed && ownGeneration === generation) items.value = result
  }
  async function load() {
    if (busy.value || disposed) return
    const handleCredentialFailure = session.captureCredentialFailureHandler()
    busy.value = true
    message.value = ""
    try {
      await refresh()
    } catch (error) {
      if (!disposed) {
        handleCredentialFailure(error)
        message.value = "列表未加载，请重试。"
      }
    } finally {
      if (!disposed) busy.value = false
    }
  }
  async function mutate(action: () => Promise<unknown>) {
    if (busy.value || disposed) return false
    const handleCredentialFailure = session.captureCredentialFailureHandler()
    busy.value = true
    needsReauthentication.value = false
    message.value = ""
    let succeeded = false
    try {
      await action()
      succeeded = true
      if (disposed) return false
      message.value = "操作已成功。"
      try {
        await refresh()
      } catch (error) {
        if (!disposed) {
          handleCredentialFailure(error)
          message.value = "操作已成功，列表未刷新，请手动重试刷新。"
        }
      }
      return true
    } catch (error) {
      if (!disposed) {
        handleCredentialFailure(error)
        needsReauthentication.value =
          error instanceof ApiError &&
          error.type.endsWith("/recent-authentication-required")
        message.value = needsReauthentication.value
          ? "请重新验证身份，再确认本次操作。"
          : error instanceof Error
            ? error.message
            : "操作未完成，请重试。"
      }
      return succeeded
    } finally {
      if (!disposed) busy.value = false
    }
  }
  onUnmounted(() => {
    disposed = true
    generation++
    reader?.abort()
    items.value = []
  })
  return {
    items: readonly(items),
    busy: readonly(busy),
    message: readonly(message),
    needsReauthentication: readonly(needsReauthentication),
    load,
    mutate,
  }
}

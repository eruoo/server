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
    try {
      const result = await read(reader.signal)
      if (disposed || ownGeneration !== generation) return
      items.value = result
    } catch (error) {
      // A read that a newer read (or a reset) replaced no longer describes the
      // current scope, so only the surviving read reports errors.
      if (disposed || ownGeneration !== generation) return
      throw error
    }
  }
  /**
   * Drops everything the previous read scope produced: the items, the message
   * and the re-authentication prompt. A caller whose read scope changed
   * (another profile, another filter) uses this so the previous scope's data
   * can never be shown again or acted on with the new scope.
   *
   * Call it while the list is idle (no read or mutation in flight): a scope
   * change is a user-facing switch, and the caller's own busy gate covers it.
   */
  function reset() {
    generation++
    reader?.abort()
    reader = undefined
    items.value = []
    message.value = ""
    needsReauthentication.value = false
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
    reset,
  }
}

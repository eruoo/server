import { readonly, shallowRef } from "vue"

const pending = shallowRef(false)
let activeWriteToken: symbol | undefined

export const nativeClipboardWritePending = readonly(pending)

export function startNativeClipboardWrite(
  text: string,
): Promise<void> | undefined {
  if (activeWriteToken !== undefined) return undefined

  const writeToken = Symbol("native-clipboard-write")
  activeWriteToken = writeToken
  pending.value = true

  let write: Promise<void>
  try {
    write = Promise.resolve(navigator.clipboard.writeText(text))
  } catch (error) {
    write = Promise.reject(error)
  }

  return write.finally(() => {
    if (activeWriteToken !== writeToken) return

    activeWriteToken = undefined
    pending.value = false
  })
}

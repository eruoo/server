import { readonly, shallowRef } from "vue"
const inFlight = shallowRef(false)
export const clipboardBusy = readonly(inFlight)
export async function copyCredential(value: string): Promise<void> {
  if (inFlight.value) throw new Error("上一次复制仍未完成，请稍后重试。")
  inFlight.value = true
  try {
    await navigator.clipboard.writeText(value)
  } finally {
    inFlight.value = false
  }
}

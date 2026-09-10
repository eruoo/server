import { authClient } from "../../lib/auth-client"
import { ApiError, requestJson } from "../../lib/http"
export interface PasskeyRecord {
  id: string
  name?: string
  createdAt: string | Date
}
export const listPasskeys = (signal: AbortSignal) =>
  requestJson<PasskeyRecord[]>("/api/auth/passkey/list-user-passkeys", {
    signal,
  })
export async function addPasskey(name: string) {
  const result = await authClient.passkey.addPasskey({ name })
  if (result?.error) {
    const error = result.error as {
      status?: number
      type?: string
      message?: string
    }
    throw new ApiError(
      error.status ?? 400,
      error.type ?? "",
      error.message ?? "Passkey 注册已取消或未完成。",
    )
  }
}
export const renamePasskey = (id: string, name: string) =>
  requestJson("/api/auth/passkey/update-passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  })
export const removePasskey = (id: string) =>
  requestJson("/api/auth/passkey/delete-passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  })

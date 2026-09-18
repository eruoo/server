import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/client"

import { API_KEY_DEFAULT_CONFIG_ID } from "../../../shared/api-key"
import { ApiError, deadlineFetch } from "../../lib/http"
const client = createAuthClient({
  plugins: [apiKeyClient()],
  fetchOptions: { customFetchImpl: deadlineFetch, retry: 0 },
})
export type ManagedApiKey = Awaited<ReturnType<typeof listApiKeys>>[number]
export async function listApiKeys(signal: AbortSignal) {
  const result = await client.apiKey.list({
    query: { configId: API_KEY_DEFAULT_CONFIG_ID },
    fetchOptions: { signal },
  })
  checkError(result.error)
  if (!result.data) throw new Error("密钥列表未加载")
  return result.data.apiKeys
}
function checkError(
  error: {
    status: number
    message?: string
    type?: string
    detail?: string
  } | null,
) {
  if (error)
    throw new ApiError(
      error.status,
      error.type ?? "",
      error.detail ?? error.message ?? "操作未完成",
    )
}
export async function createApiKey(name: string, days: number) {
  const response = await client.apiKey.create({ name, expiresIn: days * 86400 })
  checkError(response.error)
  if (!response.data) throw new Error("未收到密钥")
  return response.data
}
export async function renameApiKey(keyId: string, name: string) {
  const result = await client.apiKey.update({
    keyId,
    name,
    configId: API_KEY_DEFAULT_CONFIG_ID,
  })
  checkError(result.error)
}
export async function removeApiKey(keyId: string) {
  const result = await client.apiKey.delete({
    keyId,
    configId: API_KEY_DEFAULT_CONFIG_ID,
  })
  checkError(result.error)
}

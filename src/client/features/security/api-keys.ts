import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/client"

import {
  API_KEY_AI_CONFIG_ID,
  API_KEY_DEFAULT_CONFIG_ID,
} from "../../../shared/api-key"
import { ApiError, deadlineFetch, requestJson } from "../../lib/http"
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

/**
 * Profile-aware API key operations.
 *
 * The gateway owns the profile rules; the client always names the profile it
 * is reading or changing and never aggregates across profiles before acting
 * on one of them. `purpose` selects the profile on creation only.
 */
export async function listApiKeysForProfile(
  signal: AbortSignal,
  configId: string,
) {
  const body = await requestJson<{ apiKeys: ManagedApiKey[] }>(
    `/api/auth/api-key/list?configId=${encodeURIComponent(configId)}`,
    { signal },
  )
  return body.apiKeys
}

export async function createApiKeyForProfile(input: {
  configId: string
  days: number
  connectionId?: string
  modelIds?: string[]
  name: string
}) {
  const body = await requestJson<{ key: string } & ManagedApiKey>(
    "/api/auth/api-key/create",
    {
      body: JSON.stringify({
        expiresIn: input.days * 86400,
        name: input.name,
        purpose: input.configId === API_KEY_AI_CONFIG_ID ? "ai" : "status",
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
        ...(input.modelIds === undefined ? {} : { modelIds: input.modelIds }),
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  return body
}

export async function renameApiKeyInProfile(
  configId: string,
  keyId: string,
  name: string,
) {
  await requestJson("/api/auth/api-key/update", {
    body: JSON.stringify({ configId, keyId, name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

export async function updateAiKeyModelGrants(
  keyId: string,
  name: string,
  connectionId: string,
  modelIds: string[],
) {
  await requestJson("/api/auth/api-key/update", {
    body: JSON.stringify({
      configId: API_KEY_AI_CONFIG_ID,
      keyId,
      name,
      connectionId,
      modelIds,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

export async function removeApiKeyFromProfile(configId: string, keyId: string) {
  await requestJson("/api/auth/api-key/delete", {
    body: JSON.stringify({ configId, keyId }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

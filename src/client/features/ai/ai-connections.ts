import { requestJson } from "../../lib/http"

/**
 * AI connection management client.
 *
 * The server owns every rule: slugs are immutable, model snapshots are
 * read-only here, and device authorization is a two-step flow (start, then
 * bounded polls). This module only moves the wire shapes.
 */

export interface AiConnectionModel {
  capabilities: unknown
  discoveredAt: number
  displayName: string | null
  id: string
}

export interface AiConnection {
  authorizationStatus: string
  createdAt: number
  credentialExpiresAt: number | null
  enabled: boolean
  id: string
  models: AiConnectionModel[]
  name: string
  providerType: string
  slug: string
  updatedAt: number
  upstreamAccountId: string | null
}

export interface AiProviderDefinition {
  authorizationKind: string
  deviceVerificationUrl: string
  issuer: string
  providerType: string
  responsesStyle: string
}

export interface AiAuthorizationStart {
  authorizationId: string
  expiresAt: number
  intervalMs: number
  userCode: string
  verificationUrl: string
}

export interface AiAuthorizationStatus {
  nextPollAt?: number
  status: string
}

export async function listAiConnections(
  signal: AbortSignal,
): Promise<AiConnection[]> {
  const body = await requestJson<{ connections: AiConnection[] }>(
    "/api/ai/connections",
    { signal },
  )
  return body.connections
}

export async function listAiProviders(
  signal: AbortSignal,
): Promise<AiProviderDefinition[]> {
  const body = await requestJson<{ providers: AiProviderDefinition[] }>(
    "/api/ai/providers",
    { signal },
  )
  return body.providers
}

export async function createAiConnection(
  slug: string,
  name: string,
): Promise<AiConnection> {
  const body = await requestJson<{ connection: AiConnection }>(
    "/api/ai/connections",
    {
      body: JSON.stringify({ name, slug }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  )
  return body.connection
}

export async function renameAiConnection(
  id: string,
  name: string,
): Promise<void> {
  await requestJson(`/api/ai/connections/${id}`, {
    body: JSON.stringify({ name }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  })
}

export async function setAiConnectionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await requestJson(`/api/ai/connections/${id}`, {
    body: JSON.stringify({ enabled }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  })
}

const jsonHeaders = { "content-type": "application/json" }

export async function disconnectAiConnection(id: string): Promise<void> {
  await requestJson(`/api/ai/connections/${id}/disconnect`, {
    headers: jsonHeaders,
    method: "POST",
  })
}

export async function deleteAiConnection(id: string): Promise<void> {
  await requestJson(`/api/ai/connections/${id}`, {
    headers: jsonHeaders,
    method: "DELETE",
  })
}

export async function refreshAiModels(id: string): Promise<number> {
  const body = await requestJson<{ modelCount: number }>(
    `/api/ai/connections/${id}/models/refresh`,
    { headers: jsonHeaders, method: "POST" },
  )
  return body.modelCount
}

export async function startAiAuthorization(
  id: string,
): Promise<AiAuthorizationStart> {
  return requestJson<AiAuthorizationStart>(
    `/api/ai/connections/${id}/authorizations`,
    { headers: jsonHeaders, method: "POST" },
  )
}

export async function pollAiAuthorization(
  authorizationId: string,
): Promise<AiAuthorizationStatus> {
  return requestJson<AiAuthorizationStatus>(
    `/api/ai/authorizations/${authorizationId}/poll`,
    { headers: jsonHeaders, method: "POST" },
  )
}

export async function cancelAiAuthorization(
  authorizationId: string,
): Promise<void> {
  await requestJson(`/api/ai/authorizations/${authorizationId}`, {
    headers: jsonHeaders,
    method: "DELETE",
  })
}

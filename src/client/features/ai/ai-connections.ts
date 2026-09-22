import { requestJson } from "../../lib/http"
export interface AiConnectionModel {
  capabilities: unknown
  discoveredAt: number
  displayName: string | null
  id: string
}
export interface AiConnection {
  authorizationStatus: string
  createdAt: number
  credentialVersion: number
  permissionVersion: number
  enabled: boolean
  id: string
  models: AiConnectionModel[]
  name: string
  providerType: string
  updatedAt: number
}
export interface AiProviderDefinition {
  authorizationKind: string
  providerType: string
  responsesStyle: string
  defaultReasoningEffort: string
}
export type AiConnectionState =
  | "authorized"
  | "never-authorized"
  | "reauthentication-required"
  | "disabled"
export const AI_AUTHORIZATION_STATE_LABELS = {
  authorized: "Key 已配置",
  "never-authorized": "尚未配置 Key",
  "reauthentication-required": "需要配置有效 Key",
  disabled: "已停用",
}
export function readAiConnectionState(
  connection: Pick<AiConnection, "authorizationStatus" | "enabled">,
): AiConnectionState {
  if (!connection.enabled) return "disabled"
  return connection.authorizationStatus === "connected"
    ? "authorized"
    : connection.authorizationStatus === "reauthentication_required"
      ? "reauthentication-required"
      : "never-authorized"
}
export function readAiModelCapabilities(value: unknown) {
  const record = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>
  return {
    supportedInApi: record.supportedInApi === true,
    vision: record.vision === true,
    reasoningEfforts: Array.isArray(record.reasoningEfforts)
      ? record.reasoningEfforts.filter(
          (v): v is string => typeof v === "string",
        )
      : [],
  }
}
export function describeAiModelCapabilities(value: unknown): string {
  const c = readAiModelCapabilities(value)
  return c.supportedInApi
    ? `文本${c.vision ? " / 图片" : ""} · effort ${c.reasoningEfforts.join(" / ")} · 默认 max`
    : "能力未确认，暂不可调用"
}
export function describeAiProtocols(style: string) {
  return style === "responses-subset" ? "Responses（子集）" : style
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

export async function createAiConnection(name: string): Promise<AiConnection> {
  const body = await requestJson<{ connection: AiConnection }>(
    "/api/ai/connections",
    {
      body: JSON.stringify({ name }),
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

export async function saveAiCredential(
  id: string,
  apiKey: string,
  expectedVersion: number,
): Promise<void> {
  await requestJson(`/api/ai/connections/${id}/credential`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ apiKey, expectedVersion }),
  })
}
export async function refreshAiModels(id: string): Promise<void> {
  await requestJson(`/api/ai/connections/${id}/models/refresh`, {
    method: "POST",
    headers: jsonHeaders,
    deadlineMs: 35000,
  })
}

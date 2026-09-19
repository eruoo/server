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
  expiresAt?: number
  nextPollAt?: number
  status: string
}

/** The four states design §9 requires the interface to tell apart. */
export type AiConnectionState =
  | "authorized"
  | "never-authorized"
  | "reauthentication-required"
  | "disabled"

export const AI_AUTHORIZATION_STATE_LABELS: Readonly<
  Record<AiConnectionState, string>
> = {
  authorized: "连接已授权",
  "never-authorized": "尚未授权",
  "reauthentication-required": "需要重新授权",
  disabled: "已停用",
}

export function readAiConnectionState(
  connection: Pick<AiConnection, "authorizationStatus" | "enabled">,
): AiConnectionState {
  if (!connection.enabled) return "disabled"
  switch (connection.authorizationStatus) {
    case "connected":
      return "authorized"
    case "reauthentication_required":
      return "reauthentication-required"
    default:
      return "never-authorized"
  }
}

/**
 * Design §9 asks for the masked account, not the upstream account id: the
 * full identifier is an implementation detail of the connection.
 */
export function maskAiAccount(accountId: string | null): string {
  if (accountId === null || accountId.length === 0) return "未绑定账号"
  if (accountId.length <= 4) return "…" + accountId
  return accountId.slice(0, 2) + "…" + accountId.slice(-4)
}

export interface AiModelCapabilities {
  reasoningEfforts: string[]
  supportedInApi: boolean
  visibility: string | null
}

/**
 * The catalog stores capabilities as an opaque JSON payload, so the view reads
 * the three confirmed fields defensively and never claims more than is stored.
 */
export function readAiModelCapabilities(
  capabilities: unknown,
): AiModelCapabilities {
  const empty: AiModelCapabilities = {
    reasoningEfforts: [],
    supportedInApi: false,
    visibility: null,
  }
  if (typeof capabilities !== "object" || capabilities === null) return empty
  const record = capabilities as Record<string, unknown>
  return {
    reasoningEfforts: Array.isArray(record.reasoningEfforts)
      ? record.reasoningEfforts.filter(
          (effort): effort is string => typeof effort === "string",
        )
      : [],
    supportedInApi: record.supportedInApi === true,
    visibility:
      typeof record.visibility === "string" ? record.visibility : null,
  }
}

/** Design §9 view 2: protocol, confirmed capabilities and discovery time. */
export function describeAiModelCapabilities(capabilities: unknown): string {
  const read = readAiModelCapabilities(capabilities)
  const efforts =
    read.reasoningEfforts.length > 0
      ? read.reasoningEfforts.join("/")
      : "未声明"
  return `推理强度 ${efforts} · API ${read.supportedInApi ? "可用" : "不可用"}${
    read.visibility === null ? "" : ` · 可见性 ${read.visibility}`
  }`
}

/** The protocols a provider's models can be called with (§2.3, §9 view 2). */
export function describeAiProtocols(responsesStyle: string): string {
  return responsesStyle === "responses-subset"
    ? "Responses（子集）"
    : responsesStyle
}

/**
 * Design §5.1: the front end polls on the server's schedule, defaults to 5 s
 * when the upstream indication is missing or invalid, and never polls faster
 * than 1 s.
 */
export function readAiPollDelayMs(
  indication: { intervalMs?: number; nextPollAt?: number },
  now: number,
): number {
  const scheduled = indication.nextPollAt
  if (typeof scheduled === "number" && Number.isFinite(scheduled)) {
    return Math.max(1_000, scheduled - now)
  }
  // The start response carries the upstream interval in milliseconds; anything
  // missing or invalid falls back to 5 s.
  const interval = indication.intervalMs
  if (typeof interval === "number" && Number.isFinite(interval)) {
    return Math.max(1_000, interval)
  }
  return 5_000
}

const AI_MANAGEMENT_DEADLINE_MS = 35_000

/** Design §6.1: the SPA reads the persisted session again after a timeout. */
export async function getAiAuthorization(
  authorizationId: string,
  signal: AbortSignal,
): Promise<AiAuthorizationStatus> {
  return requestJson<AiAuthorizationStatus>(
    `/api/ai/authorizations/${authorizationId}`,
    { deadlineMs: AI_MANAGEMENT_DEADLINE_MS, signal },
  )
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
    {
      deadlineMs: AI_MANAGEMENT_DEADLINE_MS,
      headers: jsonHeaders,
      method: "POST",
    },
  )
}

export async function pollAiAuthorization(
  authorizationId: string,
): Promise<AiAuthorizationStatus> {
  return requestJson<AiAuthorizationStatus>(
    `/api/ai/authorizations/${authorizationId}/poll`,
    {
      deadlineMs: AI_MANAGEMENT_DEADLINE_MS,
      headers: jsonHeaders,
      method: "POST",
    },
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

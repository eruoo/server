import {
  API_KEY_AI_OPERATIONS,
  apiKeyAiModelPermissionKey,
  readAiKeyConnectionGrant,
  type AiKeyConnectionGrant,
} from "../../shared/api-key"
import { getAiConnection } from "./connections"
import { DEEPSEEK_DEFAULT_EFFORT } from "./deepseek-connector"
import { listAiModels } from "./models"
import { isAiServerIdentifier } from "./policy"
import type { ResponsesRequestBody } from "./responses-request"

/** Resolve native model IDs only within the owner-selected connection. */
export async function resolveAiModelSelection(
  database: D1Database,
  connectionId: string,
  modelIds: readonly string[],
): Promise<
  | { ok: true; selection: AiKeyConnectionGrant }
  | {
      ok: false
      reason: "duplicate-model" | "unknown-model" | "unknown-connection"
    }
> {
  if (!isAiServerIdentifier(connectionId))
    return { ok: false, reason: "unknown-connection" }
  const connection = await getAiConnection(database, connectionId)
  if (!connection) return { ok: false, reason: "unknown-connection" }
  if (new Set(modelIds).size !== modelIds.length)
    return { ok: false, reason: "duplicate-model" }
  // Empty grants are allowed even while disconnected, so access can always be revoked.
  if (modelIds.length) {
    if (!connection.enabled || connection.authorizationStatus !== "connected")
      return { ok: false, reason: "unknown-model" }
    const models = await listAiModels(database, connectionId)
    if (
      !modelIds.every((id) =>
        models.some(
          (model) =>
            model.upstreamModelId === id &&
            model.snapshotCredentialVersion === connection.credentialVersion &&
            hasResponsesCapability(model.capabilities),
        ),
      )
    )
      return { ok: false, reason: "unknown-model" }
  }
  return {
    ok: true,
    selection: {
      connectionId,
      permissionVersion: connection.permissionVersion,
      modelIds: [...modelIds],
    },
  }
}

export function buildAiKeyPermissions(
  selection: AiKeyConnectionGrant,
): Record<string, string[]> {
  return {
    ai: [...API_KEY_AI_OPERATIONS],
    [apiKeyAiModelPermissionKey(
      selection.connectionId,
      selection.permissionVersion,
    )]: [...selection.modelIds].sort(),
  }
}

function readActionList(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : []
}

export function authorizeAiInvocation(
  permissions: Record<string, string[]> | null | undefined,
  connectionId: string,
  upstreamModelId: string,
  permissionVersion = 0,
): boolean {
  const grant = readAiKeyConnectionGrant(permissions)
  return (
    readActionList(permissions?.ai).includes("invoke") &&
    grant !== null &&
    grant.connectionId === connectionId &&
    grant.permissionVersion === permissionVersion &&
    grant.modelIds.includes(upstreamModelId)
  )
}

export function authorizeAiModelRead(
  permissions: Record<string, string[]> | null | undefined,
): boolean {
  return readActionList(permissions?.ai).includes("models:read")
}

export interface AiAuthorizedModelView {
  connectionId: string
  permissionVersion: number
  upstreamModelId: string
  displayName: string | null
  capabilities: unknown
  discoveredAt: number
}

export async function listAiAuthorizedModels(
  database: D1Database,
  permissions: Record<string, string[]> | null | undefined,
): Promise<AiAuthorizedModelView[]> {
  const grant = readAiKeyConnectionGrant(permissions)
  if (!grant || !isAiServerIdentifier(grant.connectionId)) return []
  const connection = await getAiConnection(database, grant.connectionId)
  if (
    !connection ||
    !connection.enabled ||
    connection.authorizationStatus !== "connected" ||
    grant.permissionVersion !== connection.permissionVersion
  )
    return []
  const models = await listAiModels(database, connection.id)
  return models
    .filter(
      (model) =>
        grant.modelIds.includes(model.upstreamModelId) &&
        model.snapshotCredentialVersion === connection.credentialVersion &&
        hasResponsesCapability(model.capabilities),
    )
    .map((model) => ({
      connectionId: connection.id,
      permissionVersion: connection.permissionVersion,
      upstreamModelId: model.upstreamModelId,
      displayName: model.displayName,
      capabilities: parseCapabilities(model.capabilities),
      discoveredAt: model.discoveredAt,
    }))
}

/** Parses the stored capabilities JSON; malformed values stay unconfirmed. */
function parseCapabilities(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

export function hasResponsesCapability(raw: string | null): boolean {
  const parsed = parseCapabilities(raw)
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    (parsed as { supportedInApi?: unknown }).supportedInApi === true
  )
}

export function validateAiRequestCapabilities(input: {
  capabilities: string | null
  request: ResponsesRequestBody
}): { ok: true } | { ok: false; field: string } {
  const parsed = parseCapabilities(input.capabilities)
  const capabilities = (
    typeof parsed === "object" && parsed !== null ? parsed : {}
  ) as Record<string, unknown>
  if (capabilities.supportedInApi !== true) return { ok: false, field: "model" }
  const effort = input.request.reasoning?.effort ?? DEEPSEEK_DEFAULT_EFFORT
  if (
    !Array.isArray(capabilities.reasoningEfforts) ||
    !capabilities.reasoningEfforts.includes(effort)
  )
    return { ok: false, field: "reasoning.effort" }
  if (
    input.request.max_output_tokens !== undefined &&
    capabilities.maxOutputTokens !== true
  )
    return { ok: false, field: "max_output_tokens" }
  if (input.request.text && capabilities.structuredOutput !== true)
    return { ok: false, field: "text.format" }
  if (input.request.tools?.length && capabilities.functionTools !== true)
    return { ok: false, field: "tools" }
  if (
    effort !== "none" &&
    (input.request.tool_choice === "required" ||
      typeof input.request.tool_choice === "object")
  )
    return { ok: false, field: "tool_choice" }
  if (
    Array.isArray(input.request.input) &&
    input.request.input.some(
      (item) =>
        item.type === "message" &&
        item.content.some((part) => part.type === "input_image"),
    ) &&
    capabilities.vision !== true
  )
    return { ok: false, field: "input_image" }
  return { ok: true }
}

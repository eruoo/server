import { isAiConnectionSlug, isAiServerIdentifier } from "../../shared/ai"
import {
  apiKeyAiModelPermissionKey,
  API_KEY_AI_MODEL_PERMISSION_PREFIX,
  API_KEY_AI_OPERATIONS,
  formatAiExternalModelId,
  parseAiExternalModelId,
} from "../../shared/api-key"
import { getAiConnection, getAiConnectionBySlug } from "./connections"
import { listAiModels } from "./models"

/**
 * AI key model authorization.
 *
 * The catalog is the single authority: an external model ID is resolved by
 * splitting at its first slash, loading the connection by that exact slug,
 * and matching the remainder against the stored upstream model IDs with an
 * exact string comparison. Nothing is normalized and no caller string is
 * ever turned into an upstream URL. Persisted grants bind the connection's
 * immutable UUID plus the upstream model ID, so a reused slug never revives
 * an old key's access.
 */

export interface AiAuthorizedModelEntry {
  connectionId: string
  connectionSlug: string
  upstreamModelId: string
}

export type ResolveAiModelSelectionResult =
  | { ok: true; entries: AiAuthorizedModelEntry[] }
  | { ok: false; reason: "duplicate-model" | "unknown-model" }

/** Resolves owner-selected external model IDs against the current catalog. */
export async function resolveAiModelSelection(
  database: D1Database,
  externalModelIds: readonly string[],
): Promise<ResolveAiModelSelectionResult> {
  const seen = new Set<string>()
  const entries: AiAuthorizedModelEntry[] = []
  for (const externalModelId of externalModelIds) {
    if (seen.has(externalModelId))
      return { ok: false, reason: "duplicate-model" }
    seen.add(externalModelId)
    const parts = parseAiExternalModelId(externalModelId)
    // A malformed slug is an unknown model, never a thrown error: the
    // selection comes straight from the caller.
    if (parts === null || !isAiConnectionSlug(parts.connectionSlug)) {
      return { ok: false, reason: "unknown-model" }
    }
    const connection = await getAiConnectionBySlug(
      database,
      parts.connectionSlug,
    )
    if (
      connection === null ||
      !connection.enabled ||
      connection.authorizationStatus !== "connected"
    ) {
      return { ok: false, reason: "unknown-model" }
    }
    const models = await listAiModels(database, connection.id)
    if (
      !models.some((model) => model.upstreamModelId === parts.upstreamModelId)
    ) {
      return { ok: false, reason: "unknown-model" }
    }
    entries.push({
      connectionId: connection.id,
      connectionSlug: connection.slug,
      upstreamModelId: parts.upstreamModelId,
    })
  }
  return { ok: true, entries }
}

/**
 * Builds the plugin `permissions` object for an AI key: the fixed operations
 * plus one `ai-model:<connection UUID>` action list per connection, sorted
 * for a deterministic stored value.
 */
export function buildAiKeyPermissions(
  entries: readonly AiAuthorizedModelEntry[],
): Record<string, string[]> {
  const permissions: Record<string, string[]> = {
    ai: [...API_KEY_AI_OPERATIONS],
  }
  const byConnection = new Map<string, Set<string>>()
  for (const entry of entries) {
    const models = byConnection.get(entry.connectionId) ?? new Set<string>()
    models.add(entry.upstreamModelId)
    byConnection.set(entry.connectionId, models)
  }
  for (const connectionId of [...byConnection.keys()].sort()) {
    permissions[apiKeyAiModelPermissionKey(connectionId)] = [
      ...(byConnection.get(connectionId) ?? []),
    ].sort()
  }
  return permissions
}

/**
 * Reads one stored action list defensively: the permissions JSON is durable
 * state, not a trusted identifier source, so a malformed value grants
 * nothing instead of throwing or substring-matching.
 */
function readActionList(value: unknown): string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : []
}

/** Both checks must pass: the invoke operation and the exact model grant. */
export function authorizeAiInvocation(
  permissions: Record<string, string[]> | null | undefined,
  connectionId: string,
  upstreamModelId: string,
): boolean {
  if (!readActionList(permissions?.ai).includes("invoke")) return false
  const granted = readActionList(
    permissions?.[apiKeyAiModelPermissionKey(connectionId)],
  )
  return granted.includes(upstreamModelId)
}

/** The read operation for the model catalog listing. */
export function authorizeAiModelRead(
  permissions: Record<string, string[]> | null | undefined,
): boolean {
  return readActionList(permissions?.ai).includes("models:read")
}

export interface AiAuthorizedModelView extends AiAuthorizedModelEntry {
  externalModelId: string
  displayName: string | null
  capabilities: unknown
  discoveredAt: number
}

/**
 * Resolves the grants of one key against the current catalog. Deleted
 * connections and re-discovered catalogs drop out here, so a stale grant can
 * never list or invoke a model that is no longer present.
 */
export async function listAiAuthorizedModels(
  database: D1Database,
  permissions: Record<string, string[]> | null | undefined,
): Promise<AiAuthorizedModelView[]> {
  const views: AiAuthorizedModelView[] = []
  for (const [key, grantedModels] of Object.entries(permissions ?? {})) {
    if (!key.startsWith(API_KEY_AI_MODEL_PERMISSION_PREFIX)) continue
    const connectionId = key.slice(API_KEY_AI_MODEL_PERMISSION_PREFIX.length)
    // A tampered or legacy permission key must be skipped, not thrown on:
    // the stored JSON is not a trusted identifier source.
    if (!isAiServerIdentifier(connectionId)) continue
    const connection = await getAiConnection(database, connectionId)
    if (connection === null) continue
    const models = await listAiModels(database, connectionId)
    const granted = readActionList(grantedModels)
    for (const model of models) {
      if (!granted.includes(model.upstreamModelId)) continue
      views.push({
        capabilities: parseCapabilities(model.capabilities),
        connectionId,
        connectionSlug: connection.slug,
        discoveredAt: model.discoveredAt,
        displayName: model.displayName,
        externalModelId: formatAiExternalModelId(
          connection.slug,
          model.upstreamModelId,
        ),
        upstreamModelId: model.upstreamModelId,
      })
    }
  }
  return views.sort((left, right) =>
    left.externalModelId.localeCompare(right.externalModelId),
  )
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

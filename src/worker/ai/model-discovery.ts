import { listCodexModels } from "./codex-connector"
import { getAiConnection } from "./connections"
import type { AiCredentialServiceContext } from "./credential-lifecycle"
import { accessCodexCredentials } from "./credential-lifecycle"
import { listAiModels, commitAiModelSnapshot } from "./models"
import { AiStageUpstreamBudget } from "./stage-budget"

/**
 * Model catalog discovery for a connected Codex connection.
 *
 * Discovery is always triggered by an explicit request (owner refresh, or the
 * separate request the client sends after an authorization completes); model
 * lists never query the upstream on read. The catalog read rule implements
 * the re-discovery threshold: rows exist only while they were discovered in
 * the current credential epoch, because the atomic authorization completion
 * deletes the previous snapshot. A routine token refresh does not touch the
 * rows, so a valid catalog stays valid across refreshes.
 */

export interface AiModelCatalogEntryView {
  upstreamModelId: string
  displayName: string | null
  capabilities: {
    reasoningEfforts: string[]
    supportedInApi: boolean
    visibility: string | null
  }
  discoveredAt: number
}

export type ReadCodexModelCatalogResult =
  | { status: "available"; models: AiModelCatalogEntryView[] }
  | { status: "connection-not-found" }
  | { status: "not-connected" }
  | { status: "not-discovered" }

function parseCatalogEntryCapabilities(
  raw: string | null,
): AiModelCatalogEntryView["capabilities"] {
  if (raw === null) {
    return { reasoningEfforts: [], supportedInApi: false, visibility: null }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<{
      reasoningEfforts: unknown
      supportedInApi: unknown
      visibility: unknown
    }>
    return {
      reasoningEfforts:
        Array.isArray(parsed.reasoningEfforts) &&
        parsed.reasoningEfforts.every((value) => typeof value === "string")
          ? (parsed.reasoningEfforts as string[])
          : [],
      supportedInApi: parsed.supportedInApi === true,
      visibility:
        typeof parsed.visibility === "string" ? parsed.visibility : null,
    }
  } catch {
    return { reasoningEfforts: [], supportedInApi: false, visibility: null }
  }
}

export async function readCodexModelCatalog(
  database: D1Database,
  input: { connectionId: string },
): Promise<ReadCodexModelCatalogResult> {
  const connection = await getAiConnection(database, input.connectionId)
  if (connection === null) return { status: "connection-not-found" }
  if (connection.authorizationStatus !== "connected") {
    return { status: "not-connected" }
  }
  const rows = await listAiModels(database, connection.id)
  if (rows.length === 0) return { status: "not-discovered" }
  return {
    status: "available",
    models: rows.map((row) => ({
      upstreamModelId: row.upstreamModelId,
      displayName: row.displayName,
      capabilities: parseCatalogEntryCapabilities(row.capabilities),
      discoveredAt: row.discoveredAt,
    })),
  }
}

export type RefreshCodexModelCatalogResult =
  | { status: "committed"; modelCount: number }
  | { status: "connection-not-found" }
  | { status: "disabled" }
  | {
      status: "reauthentication-required"
      reason:
        | "not-connected"
        | "invalid-grant"
        | "refresh-outcome-unknown"
        | "refresh-claim-expired"
        | "ciphertext-unreadable"
        | "token-response-invalid"
    }
  | { status: "credential-busy" }
  | {
      status: "upstream-failure"
      keptSnapshot: boolean
      reason: "unavailable" | "protocol"
    }
  | { status: "connection-changed" }

export async function refreshCodexModelCatalog(
  context: AiCredentialServiceContext,
  input: {
    connectionId: string
    now: number
    deadlineAt: number
    signal?: AbortSignal
  },
): Promise<RefreshCodexModelCatalogResult> {
  const connection = await getAiConnection(context.database, input.connectionId)
  if (connection === null) return { status: "connection-not-found" }
  if (!connection.enabled) return { status: "disabled" }
  if (connection.authorizationStatus !== "connected") {
    return { status: "reauthentication-required", reason: "not-connected" }
  }

  // Discovery may itself require a credential refresh; the refresh consumes
  // its own budget inside the stage and surfaces its own failure states.
  const budget = new AiStageUpstreamBudget({ deadlineAt: input.deadlineAt })
  const credentials = await accessCodexCredentials(context, {
    connectionId: connection.id,
    deadlineAt: input.deadlineAt,
    now: input.now,
    signal: input.signal,
    upstream: budget,
  })
  if (credentials.status !== "usable") {
    switch (credentials.status) {
      case "connection-not-found":
        return { status: "connection-not-found" }
      case "disabled":
        return { status: "disabled" }
      case "reauthentication-required":
        return {
          status: "reauthentication-required",
          reason: credentials.reason,
        }
      case "credential-busy":
        return { status: "credential-busy" }
      case "upstream-unavailable":
        return {
          status: "upstream-failure",
          keptSnapshot: true,
          reason: "unavailable",
        }
    }
  }

  const catalogAttempt = await budget.withinBudget((options) =>
    listCodexModels(
      {
        accessToken: credentials.accessToken,
        accountId: credentials.accountId,
      },
      { signal: input.signal, timeoutMs: options.timeoutMs },
    ),
  )
  if (!catalogAttempt.ok) {
    return {
      status: "upstream-failure",
      keptSnapshot: true,
      reason: "unavailable",
    }
  }
  const catalog = catalogAttempt.value
  if (!catalog.ok) {
    // A failed discovery keeps the previous snapshot; the first failure
    // before any snapshot simply leaves the catalog undiscovered. Transport
    // failures, 5xx, and 429 are transient upstream conditions; every other
    // outcome (other HTTP statuses, unparseable payloads) is a protocol
    // problem with the fixed catalog contract.
    const previous = await listAiModels(context.database, connection.id)
    const transient =
      catalog.failure.kind === "network" ||
      (catalog.failure.kind === "http" &&
        (catalog.failure.status >= 500 || catalog.failure.status === 429))
    if (transient) {
      return {
        status: "upstream-failure",
        keptSnapshot: previous.length > 0,
        reason: "unavailable",
      }
    }
    return {
      status: "upstream-failure",
      keptSnapshot: previous.length > 0,
      reason: "protocol",
    }
  }

  const committed = await commitAiModelSnapshot(context.database, {
    connectionId: connection.id,
    models: catalog.value.map((entry) => ({
      upstreamModelId: entry.slug,
      displayName: entry.displayName,
      capabilities: JSON.stringify({
        reasoningEfforts: entry.reasoningEfforts,
        supportedInApi: entry.supportedInApi,
        visibility: entry.visibility,
      }),
    })),
    now: input.now,
    observedCredentialVersion: credentials.connection.credentialVersion,
  })
  if (committed.committed) {
    return { status: "committed", modelCount: committed.modelCount }
  }
  // The connection changed underneath the discovery (another refresh
  // committed, or a reauthorization opened a new epoch): the snapshot is not
  // written and the caller re-reads the current state.
  return { status: "connection-changed" }
}

import { apiClient, type EruooApiClient } from "@client/lib/api-client"
import {
  ApiResponseError,
  hasExactKeys,
  isNonnegativeInteger,
  isRecord,
  readApiJson,
} from "@client/lib/api-response"
import {
  OAUTH_RESOURCE,
  oauthClients,
  oauthScopes,
  type OAuthScope,
  type OAuthStaticClient,
} from "@shared/oauth"

import type { paths } from "../../../../.generated/openapi"

type AuthorizationContract =
  paths["/api/oauth/authorizations"]["get"]["responses"][200]["content"]["application/json"][number]
type AuthorizationRevocation =
  paths["/api/oauth/authorizations/{clientId}"]["delete"]["responses"][200]["content"]["application/json"]

const authorizationKeys = [
  "activeRefreshTokenCount",
  "authorized",
  "clientId",
  "consentCount",
  "enabled",
  "lastAuthorizedAt",
  "name",
  "offlineAccess",
  "platform",
  "resources",
  "scopes",
  "supportsOfflineAccess",
] as const

const revocationKeys = [
  "clientId",
  "deletedConsentCount",
  "revokedRefreshTokenCount",
] as const

export type ManagedApplicationClientId = AuthorizationContract["clientId"]
export type ManagedApplicationPlatform = AuthorizationContract["platform"]

export type AuthorizedApplication = Readonly<
  Omit<AuthorizationContract, "resources" | "scopes">
> & {
  readonly resources: readonly (typeof OAUTH_RESOURCE)[]
  readonly scopes: readonly OAuthScope[]
}

const oauthClientById = new Map<ManagedApplicationClientId, OAuthStaticClient>(
  oauthClients.map((client) => [client.clientId, client] as const),
)
const oauthClientIds = [...oauthClientById.keys()]
const oauthClientIdSet = new Set<string>(oauthClientIds)
const oauthScopeSet = new Set<string>(oauthScopes)

export interface AuthorizedApplicationsService {
  list(): Promise<readonly AuthorizedApplication[]>
  revoke(clientId: ManagedApplicationClientId): Promise<void>
}

export { ApiResponseError as AuthorizedApplicationsApiError }
export type { ApiProblem } from "@client/lib/api-response"

function isOAuthClientId(value: unknown): value is ManagedApplicationClientId {
  return typeof value === "string" && oauthClientIdSet.has(value)
}

function isOAuthScope(value: unknown): value is OAuthScope {
  return typeof value === "string" && oauthScopeSet.has(value)
}

function readUniqueArray<T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
  field: string,
): readonly T[] {
  if (
    !Array.isArray(value) ||
    !value.every(predicate) ||
    new Set(value).size !== value.length
  ) {
    throw new ApiResponseError(`OAuth authorization ${field} is invalid.`)
  }

  return value
}

function parseAuthorization(value: unknown): AuthorizedApplication {
  if (!isRecord(value) || !hasExactKeys(value, authorizationKeys)) {
    throw new ApiResponseError("OAuth authorization response is invalid.")
  }

  const clientId = value["clientId"]
  if (!isOAuthClientId(clientId)) {
    throw new ApiResponseError("OAuth authorization client is invalid.")
  }

  const expectedClient = oauthClientById.get(clientId)
  if (!expectedClient) {
    throw new ApiResponseError("OAuth authorization client is invalid.")
  }
  const activeRefreshTokenCount = value["activeRefreshTokenCount"]
  const authorized = value["authorized"]
  const consentCount = value["consentCount"]
  const enabled = value["enabled"]
  const lastAuthorizedAt = value["lastAuthorizedAt"]
  const name = value["name"]
  const offlineAccess = value["offlineAccess"]
  const platform = value["platform"]
  const supportsOfflineAccess = value["supportsOfflineAccess"]
  const resources = readUniqueArray(
    value["resources"],
    (item): item is typeof OAUTH_RESOURCE => item === OAUTH_RESOURCE,
    "resources",
  )
  const scopes = readUniqueArray(value["scopes"], isOAuthScope, "scopes")

  if (
    !isNonnegativeInteger(activeRefreshTokenCount) ||
    typeof authorized !== "boolean" ||
    !isNonnegativeInteger(consentCount) ||
    typeof enabled !== "boolean" ||
    !(lastAuthorizedAt === null || isNonnegativeInteger(lastAuthorizedAt)) ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof offlineAccess !== "boolean" ||
    platform !== expectedClient.platform ||
    supportsOfflineAccess !== expectedClient.supportsOfflineAccess
  ) {
    throw new ApiResponseError("OAuth authorization state is invalid.")
  }

  const expectedAuthorized = consentCount > 0 || activeRefreshTokenCount > 0
  const expectedOfflineAccess =
    supportsOfflineAccess && scopes.includes("offline_access")
  const allowedScopes = new Set(expectedClient.scopes)

  if (
    authorized !== expectedAuthorized ||
    (authorized ? lastAuthorizedAt === null : lastAuthorizedAt !== null) ||
    (!enabled && authorized) ||
    offlineAccess !== expectedOfflineAccess ||
    (!authorized && (resources.length > 0 || scopes.length > 0)) ||
    !scopes.every((scope) => allowedScopes.has(scope)) ||
    (scopes.includes("profile") && !scopes.includes("openid"))
  ) {
    throw new ApiResponseError("OAuth authorization invariants are invalid.")
  }

  return {
    activeRefreshTokenCount,
    authorized,
    clientId,
    consentCount,
    enabled,
    lastAuthorizedAt,
    name,
    offlineAccess,
    platform: expectedClient.platform,
    resources,
    scopes,
    supportsOfflineAccess: expectedClient.supportsOfflineAccess,
  }
}

function parseAuthorizationList(
  value: unknown,
): readonly AuthorizedApplication[] {
  if (!Array.isArray(value) || value.length !== oauthClientIds.length) {
    throw new ApiResponseError("OAuth authorization list is invalid.")
  }

  const authorizations = value.map(parseAuthorization)
  const clientIds = new Set(authorizations.map(({ clientId }) => clientId))

  if (
    clientIds.size !== oauthClientIds.length ||
    !oauthClientIds.every((clientId) => clientIds.has(clientId))
  ) {
    throw new ApiResponseError("OAuth authorization list is incomplete.")
  }

  return authorizations
}

function parseRevocation(
  value: unknown,
  requestedClientId: ManagedApplicationClientId,
): AuthorizationRevocation {
  if (!isRecord(value) || !hasExactKeys(value, revocationKeys)) {
    throw new ApiResponseError(
      "OAuth authorization revocation response is invalid.",
    )
  }

  const clientId = value["clientId"]
  const deletedConsentCount = value["deletedConsentCount"]
  const revokedRefreshTokenCount = value["revokedRefreshTokenCount"]

  if (
    clientId !== requestedClientId ||
    !isOAuthClientId(clientId) ||
    !isNonnegativeInteger(deletedConsentCount) ||
    !isNonnegativeInteger(revokedRefreshTokenCount) ||
    deletedConsentCount + revokedRefreshTokenCount === 0
  ) {
    throw new ApiResponseError(
      "OAuth authorization revocation state is invalid.",
    )
  }

  return { clientId, deletedConsentCount, revokedRefreshTokenCount }
}

export function createAuthorizedApplicationsService(
  client: EruooApiClient = apiClient,
): AuthorizedApplicationsService {
  return {
    async list() {
      return readApiJson(
        () => client.GET("/api/oauth/authorizations"),
        parseAuthorizationList,
      )
    },
    async revoke(clientId) {
      if (clientId === "eruoo-web") {
        throw new ApiResponseError("Web authorization is not owner-revocable.")
      }

      await readApiJson(
        () =>
          client.DELETE("/api/oauth/authorizations/{clientId}", {
            params: { path: { clientId } },
          }),
        (value) => parseRevocation(value, clientId),
      )
    },
  }
}

export const authorizedApplicationsService =
  createAuthorizedApplicationsService()

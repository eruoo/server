import { z } from "zod"

import {
  enabledOAuthClients,
  oauthClients,
  findOAuthClient,
  supportsOfflineAccess,
  OAUTH_RESOURCE,
  type OAuthClientId,
  type OAuthScope,
  type OAuthStaticClient,
} from "../../shared/oauth"
import { oauthAuthorizationListSchema } from "../../shared/oauth-authorizations"
import { matchesOAuthClientRegistration } from "../../shared/oauth-registration"
const storedDateSchema = z.union([z.string(), z.number().finite()])
const storedNullableDateSchema = storedDateSchema.nullable()

const storedClientRowsSchema = z.array(z.looseObject({ clientId: z.string() }))

const storedConsentRowsSchema = z.array(
  z
    .object({
      clientId: z.string(),
      createdAt: storedDateSchema,
      resources: z.string().nullable(),
      scopes: z.string(),
      updatedAt: storedDateSchema,
    })
    .strict(),
)

const storedRefreshTokenRowsSchema = z.array(
  z
    .object({
      clientId: z.string(),
      createdAt: storedDateSchema,
      expiresAt: storedDateSchema,
      resources: z.string().nullable(),
      rotatedAt: storedNullableDateSchema,
      scopes: z.string(),
    })
    .strict(),
)

interface AuthorizationAggregate {
  activeRefreshTokenCount: number
  consentCount: number
  lastAuthorizedAt: number | null
  resources: Set<string>
  scopes: Set<OAuthScope>
}

class InvalidStoredOAuthAuthorizationError extends Error {
  constructor() {
    super("Stored OAuth authorization data violates its invariant.")
    this.name = "InvalidStoredOAuthAuthorizationError"
  }
}

const allowedResources = new Set<string>([OAUTH_RESOURCE])

function invalidStoredAuthorization(): never {
  throw new InvalidStoredOAuthAuthorizationError()
}

function parseStoredDate(value: string | number): number {
  const numericValue =
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : value
  const timestamp =
    typeof numericValue === "number" ? numericValue : Date.parse(numericValue)

  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    return invalidStoredAuthorization()
  }

  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return invalidStoredAuthorization()

  if (typeof numericValue === "string" && date.toISOString() !== numericValue) {
    return invalidStoredAuthorization()
  }

  return timestamp
}

function parseStoredStringArray(
  value: string | null,
  options: {
    allowEmpty: boolean
    allowedValues: ReadonlySet<string>
    nullableAsEmpty: boolean
  },
): string[] {
  if (value === null) {
    if (options.nullableAsEmpty) return []
    return invalidStoredAuthorization()
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    return invalidStoredAuthorization()
  }

  if (
    !Array.isArray(parsed) ||
    (!options.allowEmpty && parsed.length === 0) ||
    !parsed.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item === item.trim() &&
        options.allowedValues.has(item),
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    return invalidStoredAuthorization()
  }

  return parsed
}

function parseStoredScopes(
  value: string,
  client: OAuthStaticClient,
): OAuthScope[] {
  const scopes = parseStoredStringArray(value, {
    allowEmpty: false,
    allowedValues: new Set(client.scopes),
    nullableAsEmpty: false,
  }) as OAuthScope[]

  if (scopes.includes("profile") && !scopes.includes("openid")) {
    return invalidStoredAuthorization()
  }

  return scopes
}

function parseStoredResources(value: string | null): string[] {
  return parseStoredStringArray(value, {
    allowEmpty: true,
    allowedValues: allowedResources,
    nullableAsEmpty: true,
  })
}

function validateStoredClients(rows: unknown): void {
  const clients = storedClientRowsSchema.parse(rows)
  const expectedClientIds = new Set<string>(
    enabledOAuthClients.map((client) => client.clientId),
  )
  const storedClientIds = new Set<string>()

  if (clients.length !== expectedClientIds.size) {
    return invalidStoredAuthorization()
  }

  for (const row of clients) {
    const policy = findOAuthClient(row.clientId)
    if (
      storedClientIds.has(row.clientId) ||
      !expectedClientIds.has(row.clientId) ||
      !policy ||
      !matchesOAuthClientRegistration(row, policy)
    ) {
      return invalidStoredAuthorization()
    }

    storedClientIds.add(row.clientId)
  }
}

function createAuthorizationAggregates(): Map<
  OAuthClientId,
  AuthorizationAggregate
> {
  return new Map(
    oauthClients.map((client) => [
      client.clientId,
      {
        activeRefreshTokenCount: 0,
        consentCount: 0,
        lastAuthorizedAt: null,
        resources: new Set<string>(),
        scopes: new Set<OAuthScope>(),
      },
    ]),
  )
}

function requireEnabledStoredClient(clientId: string): {
  aggregateClientId: OAuthClientId
  client: OAuthStaticClient
} {
  const client = findOAuthClient(clientId)

  if (!client || !client.enabled) {
    return invalidStoredAuthorization()
  }

  return { aggregateClientId: client.clientId, client }
}

function updateLatestAuthorization(
  aggregate: AuthorizationAggregate,
  timestamp: number,
): void {
  aggregate.lastAuthorizedAt = Math.max(
    aggregate.lastAuthorizedAt ?? 0,
    timestamp,
  )
}

function addAuthorizationValues(
  aggregate: AuthorizationAggregate,
  resources: readonly string[],
  scopes: readonly OAuthScope[],
): void {
  for (const resource of resources) aggregate.resources.add(resource)
  for (const scope of scopes) aggregate.scopes.add(scope)
}

export async function listOAuthAuthorizations(
  database: D1Database,
  subjectId: string,
  now: number,
): Promise<z.infer<typeof oauthAuthorizationListSchema>> {
  const clientIds = enabledOAuthClients.map((client) => client.clientId)
  const clientFilter = clientIds.map(() => "?").join(",")
  const results = await database.batch<unknown>([
    database
      .prepare(
        `SELECT *
       FROM oauthClient
       WHERE clientId IN (${clientFilter})
       ORDER BY clientId ASC`,
      )
      .bind(...clientIds),
    database
      .prepare(
        `SELECT clientId, createdAt, resources, scopes, updatedAt
         FROM oauthConsent
         WHERE userId = ? AND clientId IN (${clientFilter})
         ORDER BY id ASC LIMIT 1001`,
      )
      .bind(subjectId, ...clientIds),
    database
      .prepare(
        `SELECT clientId, createdAt, expiresAt, resources, rotatedAt, scopes
         FROM oauthRefreshToken
         WHERE userId = ? AND clientId IN (${clientFilter}) AND revoked IS NULL
         ORDER BY id ASC LIMIT 1001`,
      )
      .bind(subjectId, ...clientIds),
  ])

  if (results.length !== 3) return invalidStoredAuthorization()

  validateStoredClients(results[0]?.results)
  const consents = storedConsentRowsSchema.parse(results[1]?.results)
  const refreshTokens = storedRefreshTokenRowsSchema.parse(results[2]?.results)
  if (consents.length > 1000 || refreshTokens.length > 1000)
    return invalidStoredAuthorization()
  const aggregates = createAuthorizationAggregates()

  for (const row of consents) {
    const { aggregateClientId, client } = requireEnabledStoredClient(
      row.clientId,
    )
    const aggregate = aggregates.get(aggregateClientId)
    if (!aggregate) return invalidStoredAuthorization()

    const createdAt = parseStoredDate(row.createdAt)
    const updatedAt = parseStoredDate(row.updatedAt)
    if (updatedAt < createdAt) return invalidStoredAuthorization()

    const resources = parseStoredResources(row.resources)
    const scopes = parseStoredScopes(row.scopes, client)

    aggregate.consentCount += 1
    updateLatestAuthorization(aggregate, updatedAt)
    addAuthorizationValues(aggregate, resources, scopes)
  }

  for (const row of refreshTokens) {
    const { aggregateClientId, client } = requireEnabledStoredClient(
      row.clientId,
    )
    const aggregate = aggregates.get(aggregateClientId)
    if (!aggregate) return invalidStoredAuthorization()

    const createdAt = parseStoredDate(row.createdAt)
    const expiresAt = parseStoredDate(row.expiresAt)
    const rotatedAt =
      row.rotatedAt === null ? null : parseStoredDate(row.rotatedAt)
    if (
      expiresAt < createdAt ||
      (rotatedAt !== null && rotatedAt < createdAt)
    ) {
      return invalidStoredAuthorization()
    }

    const resources = parseStoredResources(row.resources)
    const scopes = parseStoredScopes(row.scopes, client)

    if (rotatedAt !== null || expiresAt <= now) continue
    if (!supportsOfflineAccess(client)) return invalidStoredAuthorization()

    aggregate.activeRefreshTokenCount += 1
    updateLatestAuthorization(aggregate, createdAt)
    addAuthorizationValues(aggregate, resources, scopes)
  }

  return oauthAuthorizationListSchema.parse(
    oauthClients.map((client) => {
      const aggregate = aggregates.get(client.clientId)
      if (!aggregate) return invalidStoredAuthorization()

      const resources = [...aggregate.resources].sort()
      const scopes = [...aggregate.scopes].sort()
      const authorized =
        aggregate.consentCount > 0 || aggregate.activeRefreshTokenCount > 0

      return {
        activeRefreshTokenCount: aggregate.activeRefreshTokenCount,
        authorized,
        clientId: client.clientId,
        consentCount: aggregate.consentCount,
        enabled: client.enabled,
        lastAuthorizedAt: authorized ? aggregate.lastAuthorizedAt : null,
        name: client.name,
        offlineAccess:
          supportsOfflineAccess(client) && scopes.includes("offline_access"),
        platform: client.platform,
        resources,
        scopes,
        supportsOfflineAccess: supportsOfflineAccess(client),
      }
    }),
  )
}

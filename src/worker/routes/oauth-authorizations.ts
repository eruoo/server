import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"

import {
  enabledOAuthClients,
  oauthClients,
  oauthScopes,
  OAUTH_RESOURCE,
  type OAuthClientId,
  type OAuthScope,
  type OAuthStaticClient,
} from "../../shared/oauth"
import { scheduleAuditEvent } from "../audit"
import { requireOwnerSession, requireRecentOwnerSession } from "../auth/session"
import { problemSchema } from "../http/problem"
import {
  problemTypeRegistry,
  problemTypeUri,
  type ProblemSlug,
} from "../http/problem-registry"
import type { AppBindings } from "../http/types"

const oauthClientIdSchema = z.enum(
  oauthClients.map((client) => client.clientId),
)
const oauthPlatformSchema = z.enum(
  oauthClients.map((client) => client.platform),
)

const oauthAuthorizationSchema = z
  .object({
    activeRefreshTokenCount: z.int().nonnegative(),
    authorized: z.boolean(),
    clientId: oauthClientIdSchema,
    consentCount: z.int().nonnegative(),
    enabled: z.boolean(),
    lastAuthorizedAt: z.int().nonnegative().nullable().openapi({
      description:
        "Most recent authorization activity as Unix epoch milliseconds, or null when the application is not authorized.",
      format: "int64",
    }),
    name: z.string().min(1),
    offlineAccess: z.boolean(),
    platform: oauthPlatformSchema,
    resources: z.array(z.literal(OAUTH_RESOURCE)),
    scopes: z.array(z.enum(oauthScopes)),
    supportsOfflineAccess: z.boolean(),
  })
  .strict()
  .openapi("OAuthAuthorization")

const oauthAuthorizationListSchema = z.array(oauthAuthorizationSchema)

const revokeOAuthAuthorizationSchema = z
  .object({
    clientId: oauthClientIdSchema,
    deletedConsentCount: z.int().nonnegative(),
    revokedRefreshTokenCount: z.int().nonnegative(),
  })
  .strict()
  .openapi("OAuthAuthorizationRevocation")

const storedDateSchema = z.union([z.string(), z.number().finite()])
const storedNullableDateSchema = storedDateSchema.nullable()

const storedClientRowsSchema = z.array(
  z
    .object({
      clientId: z.string(),
      disabled: z.int().nullable(),
    })
    .strict(),
)

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

function findStaticClient(clientId: string): OAuthStaticClient | undefined {
  return oauthClients.find((client) => client.clientId === clientId)
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
    if (
      storedClientIds.has(row.clientId) ||
      !expectedClientIds.has(row.clientId) ||
      row.disabled !== 0
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
  const client = findStaticClient(clientId)

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

async function listOAuthAuthorizations(
  database: D1Database,
  subjectId: string,
  now: number,
): Promise<z.infer<typeof oauthAuthorizationListSchema>> {
  const results = await database.batch<unknown>([
    database.prepare(
      `SELECT clientId, disabled
       FROM oauthClient
       ORDER BY clientId ASC`,
    ),
    database
      .prepare(
        `SELECT clientId, createdAt, resources, scopes, updatedAt
         FROM oauthConsent
         WHERE userId = ?1
         ORDER BY id ASC`,
      )
      .bind(subjectId),
    database
      .prepare(
        `SELECT clientId, createdAt, expiresAt, resources, rotatedAt, scopes
         FROM oauthRefreshToken
         WHERE userId = ?1 AND revoked IS NULL
         ORDER BY id ASC`,
      )
      .bind(subjectId),
  ])

  if (results.length !== 3) return invalidStoredAuthorization()

  validateStoredClients(results[0]?.results)
  const consents = storedConsentRowsSchema.parse(results[1]?.results)
  const refreshTokens = storedRefreshTokenRowsSchema.parse(results[2]?.results)
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
          client.supportsOfflineAccess && scopes.includes("offline_access"),
        platform: client.platform,
        resources,
        scopes,
        supportsOfflineAccess: client.supportsOfflineAccess,
      }
    }),
  )
}

function createProblemBody(
  context: Context<AppBindings>,
  slug: ProblemSlug,
  detail: string,
) {
  const definition = problemTypeRegistry[slug]

  return problemSchema.parse({
    detail,
    requestId: context.get("requestId"),
    status: definition.status,
    title: definition.title,
    type: problemTypeUri(slug),
  })
}

function readMutationChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta.changes

  if (!Number.isSafeInteger(changes) || changes === undefined || changes < 0) {
    return invalidStoredAuthorization()
  }

  return changes
}

async function validateDatabaseClientConfiguration(
  database: D1Database,
): Promise<void> {
  const result = await database
    .prepare(
      `SELECT clientId, disabled
       FROM oauthClient
       ORDER BY clientId ASC`,
    )
    .all<unknown>()

  validateStoredClients(result.results)
}

const listOAuthAuthorizationsRoute = createRoute({
  method: "get",
  operationId: "listOAuthAuthorizations",
  path: "/api/oauth/authorizations",
  security: [{ ownerSession: [] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: oauthAuthorizationListSchema,
        },
      },
      description: "The static Web, Desktop, and Mobile authorization summary.",
    },
    400: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request contains ambiguous credential carriers.",
    },
    401: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "A valid owner Session is required.",
    },
    500: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request failed unexpectedly.",
    },
    503: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description:
        "The OAuth authorization database is unavailable or violates its invariant.",
    },
    504: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request exceeded the service time limit.",
    },
  },
  tags: ["Security"],
})

const revokeOAuthAuthorizationRoute = createRoute({
  method: "delete",
  operationId: "revokeOAuthAuthorization",
  path: "/api/oauth/authorizations/{clientId}",
  request: {
    params: z.object({ clientId: z.string() }),
  },
  security: [{ ownerSession: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: revokeOAuthAuthorizationSchema },
      },
      description:
        "All unrevoked refresh tokens and all consents for the owner and client were revoked.",
    },
    400: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request contains ambiguous credential carriers.",
    },
    401: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "A valid owner Session is required.",
    },
    403: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description:
        "Recent owner authentication is required, or the client does not support owner-managed offline access.",
    },
    404: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The client or its owner authorization does not exist.",
    },
    413: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request body exceeds the 1 MiB operation limit.",
    },
    429: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description:
        "The owner authorization revocation rate limit was exceeded.",
    },
    500: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request failed unexpectedly.",
    },
    503: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description:
        "The OAuth authorization database or rate limiter is unavailable, or stored state violates its invariant.",
    },
    504: {
      content: {
        "application/problem+json": { schema: problemSchema },
      },
      description: "The request exceeded the service time limit.",
    },
  },
  tags: ["Security"],
})

export const oauthAuthorizationsRouter = new OpenAPIHono<AppBindings>({
  strict: true,
})

oauthAuthorizationsRouter.use("/api/oauth/authorizations", requireOwnerSession)
oauthAuthorizationsRouter.use(
  "/api/oauth/authorizations/:clientId",
  async (context, next) => {
    if (context.req.method !== "DELETE") return next()
    return requireRecentOwnerSession(context, next)
  },
)

oauthAuthorizationsRouter.openapi(
  listOAuthAuthorizationsRoute,
  async (context) => {
    try {
      const authorizations = await listOAuthAuthorizations(
        context.env.DB,
        context.var.principal.subject,
        Date.now(),
      )

      return context.json(authorizations, 200, {
        "Cache-Control": "private, no-store",
      })
    } catch (error) {
      console.error({
        error: error instanceof Error ? error.name : "unknown_error",
        event: "oauth_authorizations_query_failed",
        requestId: context.get("requestId"),
      })

      return context.json(
        createProblemBody(
          context,
          "service-unavailable",
          "OAuth authorization state is temporarily unavailable.",
        ),
        503,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }
  },
)

oauthAuthorizationsRouter.openapi(
  revokeOAuthAuthorizationRoute,
  async (context) => {
    const { clientId } = context.req.valid("param")
    const client = findStaticClient(clientId)

    if (!client) {
      return context.json(
        createProblemBody(
          context,
          "not-found",
          "The OAuth application does not exist.",
        ),
        404,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }

    if (!client.supportsOfflineAccess || client.platform === "web") {
      return context.json(
        createProblemBody(
          context,
          "permission-denied",
          "This OAuth application does not support owner-managed offline access.",
        ),
        403,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }

    const subjectId = context.var.principal.subject

    try {
      await validateDatabaseClientConfiguration(context.env.DB)

      const revocationTime = new Date()
      const revokedAt = revocationTime.toISOString()
      const results = await context.env.DB.batch<unknown>([
        context.env.DB.prepare(
          `INSERT OR IGNORE INTO oauthRefreshTokenFamilyRevocation (
             authorizationCodeId, clientId, userId, revokedAt
           )
           SELECT DISTINCT authorizationCodeId, clientId, userId, ?1
           FROM oauthRefreshToken
           WHERE userId = ?2
             AND clientId = ?3
             AND authorizationCodeId IS NOT NULL`,
        ).bind(revocationTime.getTime(), subjectId, client.clientId),
        context.env.DB.prepare(
          `UPDATE oauthRefreshToken
             SET revoked = ?1
             WHERE userId = ?2 AND clientId = ?3 AND revoked IS NULL`,
        ).bind(revokedAt, subjectId, client.clientId),
        context.env.DB.prepare(
          `DELETE FROM oauthConsent
             WHERE userId = ?1 AND clientId = ?2`,
        ).bind(subjectId, client.clientId),
      ])

      if (results.length !== 3) return invalidStoredAuthorization()

      const revokedRefreshTokenCount = readMutationChanges(results[1])
      const deletedConsentCount = readMutationChanges(results[2])

      if (revokedRefreshTokenCount + deletedConsentCount === 0) {
        return context.json(
          createProblemBody(
            context,
            "not-found",
            "The owner has no authorization for this OAuth application.",
          ),
          404,
          {
            "Cache-Control": "no-store",
            "Content-Type": "application/problem+json",
          },
        )
      }

      const response = revokeOAuthAuthorizationSchema.parse({
        clientId: client.clientId,
        deletedConsentCount,
        revokedRefreshTokenCount,
      })

      scheduleAuditEvent(context, {
        clientId: client.clientId,
        metadata: { deletedConsentCount, revokedRefreshTokenCount },
        outcome: "success",
        subjectId,
        type: "oauth_grant_revoked",
      })

      return context.json(response, 200, {
        "Cache-Control": "private, no-store",
      })
    } catch (error) {
      console.error({
        error: error instanceof Error ? error.name : "unknown_error",
        event: "oauth_authorization_revocation_failed",
        requestId: context.get("requestId"),
      })

      return context.json(
        createProblemBody(
          context,
          "service-unavailable",
          "The OAuth authorization could not be revoked.",
        ),
        503,
        {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        },
      )
    }
  },
)

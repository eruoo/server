import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import {
  AI_INVOCATION_HISTORY_DEFAULT_LIMIT,
  AI_INVOCATION_HISTORY_MAX_LIMIT,
  AI_MANAGEMENT_STAGE_BUDGET_MS,
  isAiServerIdentifier,
} from "../../shared/ai"
import { scheduleAuditEvent } from "../audit"
import { limitAuthEntry } from "../auth/entry-limit"
import { readOwnerSession } from "../auth/session"
import { boundedRequest, errorResponse, problem } from "../http/response"
import type { AppBindings, OwnerSession } from "../http/types"
import {
  cancelCodexAuthorization,
  pollCodexAuthorization,
  readCodexAuthorizationStatus,
  startCodexAuthorization,
} from "./authorization-flow"
import {
  CODEX_PROVIDER_TYPE,
  getCodexProviderDefinition,
} from "./codex-connector"
import {
  createAiConnection,
  deleteAiConnection,
  disconnectAiConnection,
  getAiConnection,
  listAiConnections,
  updateAiConnection,
} from "./connections"
import { listAiInvocationHistory } from "./invocations"
import { refreshCodexModelCatalog } from "./model-discovery"
import { listAiModels } from "./models"

/**
 * AI management endpoints (§6.1).
 *
 * Reads require an owner session; every mutation additionally requires a
 * recent owner session. Authorization session reads, polls, and cancels are
 * bound to the session that created them, and the flow layer re-confirms the
 * recent authentication from persisted state before any token lands.
 * Credential and authorization internals never leave these handlers: the
 * connection view carries identity, status, and the model snapshot only.
 */

type AppContext = Parameters<
  Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]
>[0]

interface AiConnectionView {
  authorizationStatus: string
  createdAt: number
  credentialExpiresAt: number | null
  enabled: boolean
  id: string
  name: string
  providerType: string
  slug: string
  updatedAt: number
  upstreamAccountId: string | null
}

function connectionView(connection: {
  id: string
  slug: string
  name: string
  providerType: string
  enabled: boolean
  authorizationStatus: string
  upstreamAccountId: string | null
  credentialExpiresAt: number | null
  createdAt: number
  updatedAt: number
}): AiConnectionView {
  return {
    authorizationStatus: connection.authorizationStatus,
    createdAt: connection.createdAt,
    credentialExpiresAt: connection.credentialExpiresAt,
    enabled: connection.enabled,
    id: connection.id,
    name: connection.name,
    providerType: connection.providerType,
    slug: connection.slug,
    updatedAt: connection.updatedAt,
    upstreamAccountId: connection.upstreamAccountId,
  }
}

/** Maps the flow's audit events onto the shared audit sink. */
function auditSink(c: AppContext, subjectId: string) {
  return (event: {
    type:
      | "ai_authorization_started"
      | "ai_authorization_completed"
      | "ai_authorization_cancelled"
    outcome: "success" | "failure"
    metadata: { connectionId: string; providerType: string }
  }): void => {
    scheduleAuditEvent(c, {
      metadata: event.metadata,
      outcome: event.outcome,
      subjectId,
      type: event.type,
    })
  }
}

function stageBudget(now: number) {
  return {
    deadlineAt: now + AI_MANAGEMENT_STAGE_BUDGET_MS,
    now,
  }
}

/**
 * Reads one bounded JSON body. Management entries keep the general 1 MiB
 * rule; only the invocation route carries the 8 MiB exception.
 */
async function readJson(
  c: AppContext,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: ReturnType<typeof problem> }
> {
  const requestId = c.get("requestId")
  const request = await boundedRequest(c.req.raw)
  if (!request)
    return { ok: false, response: problem("payload-too-large", requestId) }
  try {
    const raw = await request.text()
    return { body: JSON.parse(raw) as unknown, ok: true }
  } catch {
    return { ok: false, response: problem("invalid-request", requestId) }
  }
}

/**
 * Browser-cookie mutations require the exact Origin (SameSite cannot replace
 * CSRF protection) and the JSON content type, mirroring the /api/auth/*
 * rules for the only carrier these routes accept.
 */
function rejectMutationRequest(
  c: AppContext,
): ReturnType<typeof problem> | undefined {
  const requestId = c.get("requestId")
  if (c.req.raw.headers.get("origin") !== c.env.APP_ORIGIN) {
    return problem("permission-denied", requestId)
  }
  if (
    c.req.raw.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return problem("unsupported-media-type", requestId)
  }
  return undefined
}

const connectionIdParam = z.object({ id: z.string() })
const connectionViewSchema = z
  .object({
    authorizationStatus: z.string(),
    createdAt: z.number(),
    credentialExpiresAt: z.number().nullable(),
    enabled: z.boolean(),
    id: z.string(),
    name: z.string(),
    providerType: z.string(),
    slug: z.string(),
    updatedAt: z.number(),
    upstreamAccountId: z.string().nullable(),
  })
  .openapi("AiConnection")
const connectionWithModelsSchema = connectionViewSchema.extend({
  models: z.array(
    z.object({
      capabilities: z.unknown(),
      discoveredAt: z.number(),
      displayName: z.string().nullable(),
      id: z.string(),
    }),
  ),
})
const createConnectionBodySchema = z
  .object({ name: z.string().min(1).max(200), slug: z.string().min(1).max(64) })
  .strict()
const updateConnectionBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
const authorizationStartSchema = z.object({
  authorizationId: z.string(),
  expiresAt: z.number(),
  intervalMs: z.number(),
  userCode: z.string(),
  verificationUrl: z.string(),
})

const authorizationIdParam = z.object({ id: z.string() })

export function registerAiManagementRoutes(app: OpenAPIHono<AppBindings>) {
  const owner = async (
    c: AppContext,
    recent = false,
  ): Promise<OwnerSession | ReturnType<typeof problem>> =>
    readOwnerSession(c, recent)

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/ai/providers",
      operationId: "listAiProviders",
      security: [{ ownerSession: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Provider definitions",
          content: {
            "application/json": {
              schema: z.object({
                providers: z.array(
                  z.object({
                    authorizationKind: z.string(),
                    deviceVerificationUrl: z.string(),
                    issuer: z.string(),
                    providerType: z.string(),
                    responsesStyle: z.string(),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const session = await owner(c)
      if (session instanceof Response) return session
      return c.json({ providers: [getCodexProviderDefinition()] }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/ai/connections",
      operationId: "listAiConnections",
      security: [{ ownerSession: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Connections with model snapshots",
          content: {
            "application/json": {
              schema: z.object({
                connections: z.array(connectionWithModelsSchema),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const session = await owner(c)
      if (session instanceof Response) return session
      try {
        const connections = await listAiConnections(c.env.DB)
        const views = []
        for (const connection of connections) {
          const models = await listAiModels(c.env.DB, connection.id)
          views.push({
            ...connectionView(connection),
            models: models.map((model) => ({
              capabilities:
                model.capabilities === null
                  ? null
                  : JSON.parse(model.capabilities),
              discoveredAt: model.discoveredAt,
              displayName: model.displayName,
              id: model.upstreamModelId,
            })),
          })
        }
        return c.json({ connections: views }, 200, {
          "cache-control": "private, no-store",
        })
      } catch {
        return problem("service-unavailable", requestId)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/connections",
      operationId: "createAiConnection",
      security: [{ ownerSession: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Created connection",
          content: {
            "application/json": {
              schema: z.object({ connection: connectionViewSchema }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const body = await readJson(c)
      if (!body.ok) return body.response
      const parsed = createConnectionBodySchema.safeParse(body.body)
      if (!parsed.success) return problem("validation-failed", requestId)
      let created
      try {
        created = await createAiConnection(c.env.DB, {
          id: crypto.randomUUID(),
          name: parsed.data.name,
          now: Date.now(),
          providerType: CODEX_PROVIDER_TYPE,
          slug: parsed.data.slug,
        })
      } catch {
        return problem("validation-failed", requestId)
      }
      if (!created.created) return problem("validation-failed", requestId)
      scheduleAuditEvent(c, {
        metadata: {
          connectionId: created.connection.id,
          providerType: CODEX_PROVIDER_TYPE,
        },
        outcome: "success",
        subjectId: session.subject,
        type: "ai_connection_created",
      })
      return c.json({ connection: connectionView(created.connection) }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/ai/connections/{id}",
      operationId: "updateAiConnection",
      security: [{ ownerSession: [] }],
      request: { params: connectionIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Updated connection",
          content: {
            "application/json": {
              schema: z.object({ connection: connectionViewSchema }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const body = await readJson(c)
      if (!body.ok) return body.response
      const parsed = updateConnectionBodySchema.safeParse(body.body)
      if (!parsed.success) return problem("validation-failed", requestId)
      if (parsed.data.name === undefined && parsed.data.enabled === undefined) {
        return problem("validation-failed", requestId)
      }
      let updated
      try {
        updated = await updateAiConnection(c.env.DB, {
          ...(parsed.data.enabled === undefined
            ? {}
            : { enabled: parsed.data.enabled }),
          id,
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          now: Date.now(),
        })
      } catch {
        return problem("service-unavailable", requestId)
      }
      if (!updated.updated) {
        return problem(
          updated.reason === "not-found" ? "not-found" : "validation-failed",
          requestId,
        )
      }
      const connection = await getAiConnection(c.env.DB, id)
      if (connection === null) return problem("service-unavailable", requestId)
      scheduleAuditEvent(c, {
        metadata: { connectionId: id, providerType: CODEX_PROVIDER_TYPE },
        outcome: "success",
        subjectId: session.subject,
        type: "ai_connection_updated",
      })
      return c.json({ connection: connectionView(connection) }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/ai/connections/{id}",
      operationId: "deleteAiConnection",
      security: [{ ownerSession: [] }],
      request: { params: connectionIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Deleted connection",
          content: {
            "application/json": {
              schema: z.object({ deleted: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      let deleted
      try {
        deleted = await deleteAiConnection(c.env.DB, { id })
      } catch {
        return problem("service-unavailable", requestId)
      }
      if (!deleted.deleted) return problem("not-found", requestId)
      scheduleAuditEvent(c, {
        metadata: { connectionId: id, providerType: CODEX_PROVIDER_TYPE },
        outcome: "success",
        subjectId: session.subject,
        type: "ai_connection_deleted",
      })
      return c.json({ deleted: true }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/connections/{id}/disconnect",
      operationId: "disconnectAiConnection",
      security: [{ ownerSession: [] }],
      request: { params: connectionIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Disconnected connection",
          content: {
            "application/json": {
              schema: z.object({ disconnected: z.boolean() }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      let disconnected
      try {
        disconnected = await disconnectAiConnection(c.env.DB, {
          id,
          now: Date.now(),
        })
      } catch {
        return problem("service-unavailable", requestId)
      }
      if (!disconnected.disconnected) return problem("not-found", requestId)
      scheduleAuditEvent(c, {
        metadata: { connectionId: id, providerType: CODEX_PROVIDER_TYPE },
        outcome: "success",
        subjectId: session.subject,
        type: "ai_connection_disconnected",
      })
      return c.json({ disconnected: true }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/connections/{id}/authorizations",
      operationId: "startAiAuthorization",
      security: [{ ownerSession: [] }],
      request: { params: connectionIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Started device authorization",
          content: { "application/json": { schema: authorizationStartSchema } },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const now = Date.now()
      const started = await startCodexAuthorization(
        {
          audit: auditSink(c, session.subject),
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        {
          connectionId: id,
          ownerSessionId: session.sessionId,
          ownerUserId: session.subject,
          ...stageBudget(now),
        },
      )
      switch (started.status) {
        case "started":
          return c.json(
            {
              authorizationId: started.authorizationId,
              expiresAt: started.expiresAt,
              intervalMs: started.intervalMs,
              userCode: started.userCode,
              verificationUrl: started.verificationUrl,
            },
            200,
            { "cache-control": "private, no-store" },
          )
        case "connection-not-found":
          return problem("not-found", requestId)
        case "provider-unsupported":
          return problem("validation-failed", requestId)
        case "upstream-failure":
          return problem("ai-upstream-unavailable", requestId)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/ai/authorizations/{id}",
      operationId: "readAiAuthorization",
      security: [{ ownerSession: [] }],
      request: { params: authorizationIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Authorization status",
          content: {
            "application/json": {
              schema: z.object({ status: z.string() }).catchall(z.unknown()),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const session = await owner(c)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const result = await readCodexAuthorizationStatus(
        {
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        {
          authorizationId: id,
          now: Date.now(),
          ownerSessionId: session.sessionId,
          ownerUserId: session.subject,
        },
      )
      if (result.status === "authorization-not-found") {
        return problem("not-found", requestId)
      }
      if (result.status === "session-mismatch") {
        return problem("permission-denied", requestId)
      }
      return c.json(result, 200, { "cache-control": "private, no-store" })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/authorizations/{id}/poll",
      operationId: "pollAiAuthorization",
      security: [{ ownerSession: [] }],
      request: { params: authorizationIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "One bounded poll",
          content: {
            "application/json": {
              schema: z
                .object({
                  intervalMs: z.number().optional(),
                  nextPollAt: z.number().optional(),
                  status: z.string(),
                })
                .catchall(z.unknown()),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const now = Date.now()
      const result = await pollCodexAuthorization(
        {
          audit: auditSink(c, session.subject),
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        {
          authorizationId: id,
          ownerSessionId: session.sessionId,
          ownerUserId: session.subject,
          ...stageBudget(now),
        },
      )
      switch (result.status) {
        case "authorization-not-found":
          return problem("not-found", requestId)
        case "session-mismatch":
          return problem("permission-denied", requestId)
        case "owner-session-revoked":
        case "recent-authentication-required":
          return problem("recent-authentication-required", requestId)
        case "upstream-unavailable":
          return problem("ai-upstream-unavailable", requestId)
        case "invalid-identity":
        case "account-mismatch":
          return problem("validation-failed", requestId)
        case "rejected":
          return problem("ai-reauthorization-required", requestId)
        default:
          return c.json(result, 200, { "cache-control": "private, no-store" })
      }
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/ai/authorizations/{id}",
      operationId: "cancelAiAuthorization",
      security: [{ ownerSession: [] }],
      request: { params: authorizationIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Cancelled authorization",
          content: {
            "application/json": {
              schema: z.object({ status: z.string() }).catchall(z.unknown()),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const result = await cancelCodexAuthorization(
        {
          audit: auditSink(c, session.subject),
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        {
          authorizationId: id,
          now: Date.now(),
          ownerSessionId: session.sessionId,
          ownerUserId: session.subject,
        },
      )
      if (result.status === "authorization-not-found") {
        return problem("not-found", requestId)
      }
      if (result.status === "session-mismatch") {
        return problem("permission-denied", requestId)
      }
      return c.json(result, 200, { "cache-control": "private, no-store" })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/connections/{id}/models/refresh",
      operationId: "refreshAiModels",
      security: [{ ownerSession: [] }],
      request: { params: connectionIdParam },
      responses: {
        default: errorResponse,
        200: {
          description: "Refreshed model snapshot",
          content: {
            "application/json": {
              schema: z.object({
                modelCount: z.number(),
                status: z.literal("committed"),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectMutationRequest(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        `${c.req.method} ${new URL(c.req.url).pathname}`,
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const session = await owner(c, true)
      if (session instanceof Response) return session
      const id = c.req.param("id")
      if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
      const result = await refreshCodexModelCatalog(
        {
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        { connectionId: id, ...stageBudget(Date.now()) },
      )
      switch (result.status) {
        case "committed":
          return c.json(result, 200, { "cache-control": "private, no-store" })
        case "connection-not-found":
          return problem("not-found", requestId)
        case "disabled":
          return problem("ai-reauthorization-required", requestId)
        case "reauthentication-required":
          return problem("ai-reauthorization-required", requestId)
        case "credential-busy":
          return problem("ai-credential-busy", requestId)
        case "connection-changed":
          return problem("validation-failed", requestId)
        case "upstream-failure":
          return problem(
            result.reason === "protocol"
              ? "ai-upstream-protocol-error"
              : "ai-upstream-unavailable",
            requestId,
          )
      }
    },
  )

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/ai/invocations",
      operationId: "listAiInvocations",
      security: [{ ownerSession: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Invocation history",
          content: {
            "application/json": {
              schema: z.object({
                nextCursor: z
                  .object({ requestId: z.string(), startedAt: z.number() })
                  .nullable(),
                records: z.array(
                  z.object({
                    apiKeyId: z.string(),
                    connectionId: z.string(),
                    deadlineAt: z.number(),
                    effectiveStatus: z.string(),
                    endedAt: z.number().nullable(),
                    errorCode: z.string().nullable(),
                    leaseExpiresAt: z.number(),
                    requestId: z.string(),
                    startedAt: z.number(),
                    status: z.string(),
                    upstreamModelId: z.string(),
                    upstreamRequestId: z.string().nullable(),
                    usage: z.string().nullable(),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const session = await owner(c)
      if (session instanceof Response) return session
      const limitRaw = c.req.query("limit")
      const limit =
        limitRaw === undefined
          ? AI_INVOCATION_HISTORY_DEFAULT_LIMIT
          : Number(limitRaw)
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > AI_INVOCATION_HISTORY_MAX_LIMIT
      ) {
        return problem("validation-failed", requestId)
      }
      const beforeStartedAt = c.req.query("beforeStartedAt")
      const beforeRequestId = c.req.query("beforeRequestId")
      let before
      if (beforeStartedAt !== undefined || beforeRequestId !== undefined) {
        const startedAt = Number(beforeStartedAt)
        if (
          beforeRequestId === undefined ||
          !Number.isSafeInteger(startedAt) ||
          startedAt < 0 ||
          !isAiServerIdentifier(beforeRequestId)
        ) {
          return problem("validation-failed", requestId)
        }
        before = { requestId: beforeRequestId, startedAt }
      }
      try {
        const page = await listAiInvocationHistory(c.env.DB, {
          ...(before === undefined ? {} : { before }),
          limit,
          now: Date.now(),
        })
        return c.json(page, 200, { "cache-control": "private, no-store" })
      } catch {
        return problem("service-unavailable", requestId)
      }
    },
  )
}

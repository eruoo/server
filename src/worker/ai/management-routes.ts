import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { scheduleAuditEvent } from "../audit"
import { limitAuthEntry } from "../auth/entry-limit"
import { readOwnerSession } from "../auth/session"
import { boundedRequest, errorResponse, problem } from "../http/response"
import type { AppBindings, OwnerSession } from "../http/types"
import {
  createAiConnection,
  deleteAiConnection,
  disconnectAiConnection,
  getAiConnection,
  listAiConnections,
  updateAiConnection,
} from "./connections"
import { saveDeepSeekCredential } from "./credential-lifecycle"
import {
  DEEPSEEK_PROVIDER_TYPE,
  getDeepSeekProviderDefinition,
} from "./deepseek-connector"
import { listAiInvocationHistory } from "./invocations"
import { refreshDeepSeekModelCatalog } from "./model-discovery"
import { listAiModels } from "./models"
import {
  AI_INVOCATION_HISTORY_DEFAULT_LIMIT,
  AI_INVOCATION_HISTORY_MAX_LIMIT,
  AI_MANAGEMENT_STAGE_BUDGET_MS,
  isAiServerIdentifier,
} from "./policy"

/**
 * AI management endpoints (§6.1).
 *
 * Reads require an owner session; every mutation checks the persistent
 * session without requiring recent authentication. Authorization reads,
 * polls, and cancels are bound to the session that created them, and the flow
 * layer re-confirms its validity from persisted state before any token lands.
 * Credential and authorization internals never leave these handlers: the
 * connection view carries identity, status, and the model snapshot only.
 */

type AppContext = Parameters<
  Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]
>[0]

function connectionView(
  connection: import("./connections").AiConnectionRecord,
) {
  return {
    id: connection.id,
    slug: connection.slug,
    name: connection.name,
    providerType: connection.providerType,
    enabled: connection.enabled,
    authorizationStatus: connection.authorizationStatus,
    credentialVersion: connection.credentialVersion,
    permissionVersion: connection.permissionVersion,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
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
    credentialVersion: z.number(),
    permissionVersion: z.number(),
    enabled: z.boolean(),
    id: z.string(),
    name: z.string(),
    providerType: z.string(),
    slug: z.string(),
    updatedAt: z.number(),
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
  .object({ name: z.string().min(1).max(100), slug: z.string().min(1).max(64) })
  .strict()
const updateConnectionBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().min(1).max(100).optional(),
  })
  .strict()
const credentialBodySchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\x21-\x7e]+$/),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()

export function registerAiManagementRoutes(app: OpenAPIHono<AppBindings>) {
  const owner = async (
    c: AppContext,
    persistent = false,
  ): Promise<OwnerSession | ReturnType<typeof problem>> =>
    readOwnerSession(c, false, persistent)

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
                    defaultReasoningEffort: z.string(),
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
      return c.json({ providers: [getDeepSeekProviderDefinition()] }, 200, {
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
          providerType: DEEPSEEK_PROVIDER_TYPE,
          slug: parsed.data.slug,
        })
      } catch {
        return problem("validation-failed", requestId)
      }
      if (!created.created) return problem("validation-failed", requestId)
      scheduleAuditEvent(c, {
        metadata: {
          connectionId: created.connection.id,
          providerType: DEEPSEEK_PROVIDER_TYPE,
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
        metadata: { connectionId: id, providerType: DEEPSEEK_PROVIDER_TYPE },
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
        metadata: { connectionId: id, providerType: DEEPSEEK_PROVIDER_TYPE },
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
        metadata: { connectionId: id, providerType: DEEPSEEK_PROVIDER_TYPE },
        outcome: "success",
        subjectId: session.subject,
        type: "ai_connection_disconnected",
      })
      return c.json({ disconnected: true }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      path: "/api/ai/connections/{id}/credential",
      operationId: "saveAiCredential",
      security: [{ ownerSession: [] }],
      request: {
        params: connectionIdParam,
        body: {
          required: true,
          content: { "application/json": { schema: credentialBodySchema } },
        },
      },
      responses: {
        default: errorResponse,
        200: {
          description: "Credential saved; model discovery is separate",
          content: {
            "application/json": { schema: z.object({ saved: z.boolean() }) },
          },
        },
      },
    }),
  )
  app.put("/api/ai/connections/:id/credential", async (c) => {
    const requestId = c.get("requestId")
    const rejected = rejectMutationRequest(c)
    if (rejected) return rejected
    const limited = await limitAuthEntry(
      c,
      "PUT /api/ai/connections/credential",
      c.env.AI_RATE_LIMITER,
    )
    if (limited) return limited
    const session = await owner(c, true)
    if (session instanceof Response) return session
    const id = c.req.param("id")
    if (!isAiServerIdentifier(id)) return problem("not-found", requestId)
    const body = await readJson(c)
    if (!body.ok) return body.response
    const parsed = credentialBodySchema.safeParse(body.body)
    if (!parsed.success) return problem("validation-failed", requestId)
    let result
    try {
      result = await saveDeepSeekCredential(
        {
          database: c.env.DB,
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          environment: c.env.APP_ORIGIN,
        },
        {
          connectionId: id,
          ...parsed.data,
          owner: session,
          ownerGitHubId: c.env.OWNER_GITHUB_ID,
        },
      )
    } catch {
      return problem("service-unavailable", requestId)
    }
    if (result !== "saved")
      return problem(
        result === "invalid-session"
          ? "invalid-credential"
          : result === "not-found"
            ? "not-found"
            : "ai-connection-changed",
        requestId,
      )
    scheduleAuditEvent(c, {
      type: "ai_credential_saved",
      outcome: "success",
      subjectId: session.subject,
      metadata: { connectionId: id, providerType: DEEPSEEK_PROVIDER_TYPE },
    })
    return c.json({ saved: true }, 200, {
      "cache-control": "private, no-store",
    })
  })

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
      const result = await refreshDeepSeekModelCatalog(
        {
          credentialKeys: c.env.AI_CREDENTIAL_KEYS,
          database: c.env.DB,
          environment: c.env.APP_ORIGIN,
        },
        { connectionId: id, requestId, ...stageBudget(Date.now()) },
      )
      if (result.status === "committed")
        return c.json(result, 200, { "cache-control": "private, no-store" })
      return problem(result.problem, requestId)
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
                    connectionId: z.string().nullable(),
                    deadlineAt: z.number(),
                    effectiveStatus: z.string(),
                    endedAt: z.number().nullable(),
                    errorCode: z.string().nullable(),
                    leaseExpiresAt: z.number(),
                    requestId: z.string(),
                    startedAt: z.number(),
                    status: z.string(),
                    upstreamModelId: z.string().nullable(),
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

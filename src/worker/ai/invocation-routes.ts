import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import {
  AI_INVOCATION_TOTAL_DEADLINE_MS,
  AI_MAX_IN_FLIGHT_INVOCATIONS,
  isAiConnectionSlug,
} from "../../shared/ai"
import { parseAiExternalModelId } from "../../shared/api-key"
import { scheduleAuditEvent } from "../audit"
import { inspectCredentialCarriers } from "../auth/carriers"
import { limitAuthEntry } from "../auth/entry-limit"
import { getRequestAuth } from "../auth/session"
import { errorResponse, problem } from "../http/response"
import type { AppBindings } from "../http/types"
import { getAiConnectionBySlug } from "./connections"
import { reserveAiInvocation } from "./invocations"
import {
  authorizeAiInvocation,
  authorizeAiModelRead,
  listAiAuthorizedModels,
} from "./model-authorization"
import { listAiModels } from "./models"
import { validateResponsesRequest } from "./responses-request"
import { invokeCodexResponses } from "./responses-transport"

/**
 * Responses invocation endpoints (§6.2).
 *
 * Both endpoints authenticate with the `x-api-key` carrier only: the AI
 * profile's `ai` operations and the per-connection model grants decide what
 * a key may list and invoke. No body byte is read before the key is verified
 * and owner-bound, and a cheap in-flight pre-check rejects an obviously full
 * service before the body is read. The authoritative reservation still has
 * to follow the read, because the model ID that identifies the slot lives in
 * the body; §7's "read the body after securing the slot" is therefore
 * satisfied by the pre-check plus the atomic insert, not by the insert
 * alone.
 */

/** The exact request-body budget for the invocation route (§7). */
export const AI_RESPONSES_BODY_MAX_BYTES = 8 * 1_048_576
/** The request-body read budget, after which the route answers 504. */
export const AI_RESPONSES_BODY_READ_BUDGET_MS = 15_000
/** Admission (key verification + reservation) budget (§7). */
const AI_INVOCATION_ADMISSION_BUDGET_MS = 5_000

type VerifiedKey = {
  id: string
  permissions: Record<string, string[]> | null | undefined
  referenceId: string
}

/**
 * Verifies one `x-api-key` credential against the ai profile and the owner
 * account. Returns the key or the Problem response to send.
 */
async function verifyAiKey(
  c: Parameters<Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]>[0],
): Promise<VerifiedKey | ReturnType<typeof problem>> {
  const requestId = c.get("requestId")
  const key = c.req.header("x-api-key")
  if (key === undefined) return problem("invalid-credential", requestId)
  let result
  try {
    result = await getRequestAuth(c).api.verifyApiKey({
      body: { configId: "ai", key },
    })
  } catch {
    return problem("service-unavailable", requestId)
  }
  if (!result.valid || !result.key) {
    const code = result.error?.code
    if (code === "RATE_LIMITED" || code === "USAGE_EXCEEDED") {
      const response = problem("rate-limit-exceeded", requestId)
      response.headers.set("retry-after", "60")
      return response
    }
    if (
      code &&
      [
        "INVALID_API_KEY",
        "KEY_DISABLED",
        "KEY_EXPIRED",
        "KEY_NOT_FOUND",
      ].includes(code)
    ) {
      scheduleAuditEvent(c, {
        metadata: { reason: "invalid_credential" },
        outcome: "failure",
        type: "api_key_rejected",
      })
      return problem("invalid-credential", requestId)
    }
    return problem("service-unavailable", requestId)
  }
  const verified = result.key
  let ownerBound: unknown
  try {
    ownerBound = await c.env.DB.prepare(
      "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1",
    )
      .bind(verified.referenceId, c.env.OWNER_GITHUB_ID)
      .first()
  } catch {
    return problem("service-unavailable", requestId)
  }
  if (!ownerBound) {
    scheduleAuditEvent(c, {
      metadata: { reason: "invalid_owner" },
      outcome: "failure",
      type: "api_key_rejected",
    })
    return problem("invalid-credential", requestId)
  }
  return {
    id: verified.id,
    permissions: verified.permissions,
    referenceId: verified.referenceId,
  }
}

function rejectNonApiKeyCarrier(
  c: Parameters<Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]>[0],
): ReturnType<typeof problem> | undefined {
  const inspection = inspectCredentialCarriers(c.req.raw)
  if (inspection.invalid) return problem("invalid-request", c.get("requestId"))
  if (inspection.carriers[0] !== "apiKey") {
    // Invocation and model listing are API-key surfaces: a browser session or
    // OAuth bearer never acts as an inference credential here.
    return problem("invalid-credential", c.get("requestId"))
  }
  return undefined
}

/** Reads the request body with the exact size and time budgets. */
async function readBoundedBody(
  c: Parameters<Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]>[0],
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: ReturnType<typeof problem> }
> {
  const requestId = c.get("requestId")
  let timer: ReturnType<typeof setTimeout> | undefined
  const chunks: Uint8Array[] = []
  const reader = c.req.raw.body?.getReader()
  try {
    if (reader === undefined)
      return { ok: false, response: problem("invalid-request", requestId) }
    let size = 0
    const readAll = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > AI_RESPONSES_BODY_MAX_BYTES) return "oversize" as const
        chunks.push(value)
      }
      return "done" as const
    })()
    const outcome = await Promise.race([
      readAll,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          AI_RESPONSES_BODY_READ_BUDGET_MS,
        )
      }),
    ])
    if (outcome === "timeout") {
      await reader.cancel().catch(() => undefined)
      return { ok: false, response: problem("request-timeout", requestId) }
    }
    if (outcome === "oversize") {
      await reader.cancel().catch(() => undefined)
      return { ok: false, response: problem("payload-too-large", requestId) }
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return { ok: false, response: problem("invalid-request", requestId) }
    }
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, response: problem("invalid-request", requestId) }
  } finally {
    clearTimeout(timer)
    reader?.releaseLock()
  }
}

export function registerAiInvocationRoutes(app: OpenAPIHono<AppBindings>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/ai/models",
      operationId: "listAiModels",
      security: [{ apiKey: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Models this API key may invoke",
          content: {
            "application/json": {
              schema: z.object({
                models: z.array(
                  z.object({
                    capabilities: z.unknown(),
                    displayName: z.string().nullable(),
                    id: z.string(),
                    discoveredAt: z.number(),
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
      const rejected = rejectNonApiKeyCarrier(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        "GET /api/ai/models",
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited
      const key = await verifyAiKey(c)
      if (key instanceof Response) return key
      if (!authorizeAiModelRead(key.permissions)) {
        return problem("permission-denied", requestId)
      }
      try {
        const models = await listAiAuthorizedModels(c.env.DB, key.permissions)
        return c.json(
          {
            models: models.map((model) => ({
              capabilities: model.capabilities,
              discoveredAt: model.discoveredAt,
              displayName: model.displayName,
              id: model.externalModelId,
            })),
          },
          200,
          { "cache-control": "private, no-store" },
        )
      } catch {
        return problem("service-unavailable", requestId)
      }
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/ai/responses",
      operationId: "createAiResponse",
      security: [{ apiKey: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Responses subset as an SSE stream or a JSON terminal",
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const rejected = rejectNonApiKeyCarrier(c)
      if (rejected) return rejected
      const limited = await limitAuthEntry(
        c,
        "POST /api/ai/responses",
        c.env.AI_RATE_LIMITER,
      )
      if (limited) return limited

      const startedAt = Date.now()
      const admissionDeadline = startedAt + AI_INVOCATION_ADMISSION_BUDGET_MS
      const key = await verifyAiKey(c)
      if (key instanceof Response) return key
      if (Date.now() >= admissionDeadline) {
        return problem("request-timeout", requestId)
      }

      // Cheap pre-admission: a full service rejects before the body read.
      // The authoritative conditional insert below still decides.
      let inFlight
      try {
        inFlight = await c.env.DB.prepare(
          `SELECT COUNT(*) AS "inFlight" FROM "ai_invocations"
           WHERE "status" = 'reserved' AND "leaseExpiresAt" > ?1`,
        )
          .bind(Date.now())
          .first<{ inFlight: number }>()
      } catch {
        return problem("service-unavailable", requestId)
      }
      if (
        inFlight === null ||
        inFlight.inFlight >= AI_MAX_IN_FLIGHT_INVOCATIONS
      ) {
        const response = problem("ai-concurrency-exceeded", requestId)
        response.headers.set("retry-after", "1")
        return response
      }

      const parsed = await readBoundedBody(c)
      if (!parsed.ok) return parsed.response
      const validated = validateResponsesRequest(parsed.body)
      if (!validated.ok) return problem("validation-failed", requestId)

      // Resolve the public model ID against the live catalog, then require
      // both the invoke operation and the exact model grant. Unknown and
      // ungranted models answer identically, so the endpoint is not a
      // catalog oracle.
      const parts = parseAiExternalModelId(validated.value.model)
      let connectionId: string | null = null
      let upstreamModelId: string | null = null
      // A malformed slug is an unresolvable model, not a service failure.
      if (parts !== null && isAiConnectionSlug(parts.connectionSlug)) {
        try {
          const connection = await getAiConnectionBySlug(
            c.env.DB,
            parts.connectionSlug,
          )
          if (
            connection !== null &&
            connection.enabled &&
            connection.authorizationStatus === "connected"
          ) {
            const models = await listAiModels(c.env.DB, connection.id)
            if (
              models.some(
                (model) => model.upstreamModelId === parts.upstreamModelId,
              )
            ) {
              connectionId = connection.id
              upstreamModelId = parts.upstreamModelId
            }
          }
        } catch {
          return problem("service-unavailable", requestId)
        }
      }
      if (
        connectionId === null ||
        upstreamModelId === null ||
        !authorizeAiInvocation(key.permissions, connectionId, upstreamModelId)
      ) {
        return problem("permission-denied", requestId)
      }

      const deadlineAt = startedAt + AI_INVOCATION_TOTAL_DEADLINE_MS
      let reserved
      try {
        reserved = await reserveAiInvocation(c.env.DB, {
          apiKeyId: key.id,
          connectionId,
          deadlineAt,
          requestId,
          startedAt,
          upstreamModelId,
        })
      } catch {
        return problem("service-unavailable", requestId)
      }
      if (!reserved.reserved) {
        const response = problem("ai-concurrency-exceeded", requestId)
        response.headers.set("retry-after", "1")
        return response
      }

      const delivery = await invokeCodexResponses({
        apiKeyId: key.id,
        connectionId,
        credentialKeys: c.env.AI_CREDENTIAL_KEYS,
        database: c.env.DB,
        deadlineAt,
        environment: c.env.APP_ORIGIN,
        request: validated.value,
        requestId,
        signal: c.req.raw.signal,
        startedAt,
        upstreamModelId,
      })
      // The streaming path settles after the stream closes; the caller keeps
      // it alive so the invocation outcome is always committed. A commit that
      // cannot land rejects, and the row stays reserved for lease recovery,
      // so the rejection is reported instead of escaping.
      c.executionCtx.waitUntil(
        delivery.settled.catch((error: unknown) => {
          console.warn({
            event: "ai_invocation_settle_failed",
            message: error instanceof Error ? error.message : "unknown",
            requestId,
          })
        }),
      )
      return delivery.response
    },
  )
}

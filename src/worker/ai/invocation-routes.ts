import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { parseAiExternalModelId } from "../../shared/api-key"
import { scheduleAuditEvent } from "../audit"
import { inspectCredentialCarriers } from "../auth/carriers"
import { limitAuthEntry } from "../auth/entry-limit"
import { getRequestAuth } from "../auth/session"
import { errorResponse, problem } from "../http/response"
import type { AppBindings } from "../http/types"
import { getAiConnectionBySlug } from "./connections"
import {
  assignAiInvocationIdentity,
  releaseAiInvocationReservation,
  reserveAiInvocation,
} from "./invocations"
import {
  authorizeAiInvocation,
  authorizeAiModelRead,
  listAiAuthorizedModels,
  validateAiRequestCapabilities,
} from "./model-authorization"
import { listAiModels } from "./models"
import { AI_INVOCATION_TOTAL_DEADLINE_MS, isAiConnectionSlug } from "./policy"
import { validateResponsesRequest } from "./responses-request"
import { invokeCodexResponses } from "./responses-transport"

/**
 * Responses invocation endpoints (§6.2).
 *
 * Both endpoints authenticate with the `x-api-key` carrier only: the AI
 * profile's `ai` operations and the per-connection model grants decide what
 * a key may list and invoke. No body byte is read before the key is verified
 * and owner-bound, and the in-flight slot is taken by the same conditional
 * insert that enforces both quotas — before the body is read. That
 * reservation starts without an identity, because the model ID lives in the
 * body: it is identified once the model is resolved, authorized and checked
 * against its catalog capabilities. A request that never reaches that step
 * releases its slot immediately, and a reservation whose write landed late is
 * released by its lease.
 */

/** The exact request-body budget for the invocation route (§7). */
const AI_RESPONSES_BODY_MAX_BYTES = 8 * 1_048_576
/** The request-body read budget, after which the route answers 504. */
const AI_RESPONSES_BODY_READ_BUDGET_MS = 15_000
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

/**
 * Reads the request body with the exact size and time budgets. The read also
 * ends when the client disconnects: a cancelled request stops waiting for
 * bytes it will never receive, so the slot it holds is released promptly
 * instead of at the body-read budget.
 */
async function readBoundedBody(
  c: Parameters<Parameters<OpenAPIHono<AppBindings>["openapi"]>[1]>[0],
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: ReturnType<typeof problem> }
> {
  const requestId = c.get("requestId")
  const clientSignal = c.req.raw.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
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
    const aborted = new Promise<"aborted">((resolve) => {
      if (clientSignal.aborted) {
        resolve("aborted")
        return
      }
      onAbort = () => resolve("aborted")
      clientSignal.addEventListener("abort", onAbort, { once: true })
    })
    const outcome = await Promise.race([
      readAll,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          AI_RESPONSES_BODY_READ_BUDGET_MS,
        )
      }),
      aborted,
    ])
    if (outcome === "aborted") {
      await reader.cancel().catch(() => undefined)
      return { ok: false, response: problem("request-timeout", requestId) }
    }
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
    if (onAbort !== undefined)
      clientSignal.removeEventListener("abort", onAbort)
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
          content: {
            "application/json": { schema: z.record(z.string(), z.unknown()) },
            "text/event-stream": { schema: z.string() },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      // The total deadline runs from request arrival, so the clock starts
      // before the carrier check and the entry limiter: caller authentication
      // and admission share the same 5 second budget. The budget is an
      // absolute wall-clock deadline every admission await is raced against,
      // so a slow or hanging D1 cannot stretch the wait past it. The losing
      // work still completes — the underlying D1 write cannot be cancelled —
      // and its late result is only observed, never continued: a late
      // reservation is released by the guarded cleanup or its lease, and no
      // late chain reads the body, refreshes credentials or starts an
      // inference.
      const startedAt = Date.now()
      const admissionDeadline = startedAt + AI_INVOCATION_ADMISSION_BUDGET_MS
      const rejected = rejectNonApiKeyCarrier(c)
      if (rejected) return rejected

      let admissionTimer: ReturnType<typeof setTimeout> | undefined
      const admissionExpired = new Promise<"deadline">((resolve) => {
        admissionTimer = setTimeout(
          () => resolve("deadline"),
          Math.max(0, admissionDeadline - Date.now()),
        )
      })
      const stopAdmissionTimer = (): void => {
        if (admissionTimer !== undefined) clearTimeout(admissionTimer)
      }

      const limited = await Promise.race([
        limitAuthEntry(c, "POST /api/ai/responses", c.env.AI_RATE_LIMITER),
        admissionExpired,
      ])
      if (limited === "deadline") {
        stopAdmissionTimer()
        return problem("request-timeout", requestId)
      }
      if (limited) {
        stopAdmissionTimer()
        return limited
      }

      const keyPromise = verifyAiKey(c)
      const keyOutcome = await Promise.race([keyPromise, admissionExpired])
      if (keyOutcome === "deadline") {
        stopAdmissionTimer()
        // The late verification is only observed — its result cannot continue
        // this already-refused request — so a failure in the abandoned read is
        // reported instead of escaping.
        c.executionCtx.waitUntil(
          keyPromise.then(
            () => undefined,
            (error: unknown) => {
              console.warn({
                event: "ai_admission_late_key_failed",
                message: error instanceof Error ? error.message : "unknown",
                requestId,
              })
            },
          ),
        )
        return problem("request-timeout", requestId)
      }
      if (keyOutcome instanceof Response) {
        stopAdmissionTimer()
        return keyOutcome
      }
      const key = keyOutcome
      if (Date.now() >= admissionDeadline) {
        stopAdmissionTimer()
        return problem("request-timeout", requestId)
      }

      // The slot is taken before the body is read: the conditional insert is
      // the admission decision, so a full service or key never reads a byte of
      // the body. The connection and model are not known yet — they stay NULL
      // until the resolved, authorized model is recorded below.
      const deadlineAt = startedAt + AI_INVOCATION_TOTAL_DEADLINE_MS
      const reservePromise = reserveAiInvocation(c.env.DB, {
        apiKeyId: key.id,
        deadlineAt,
        requestId,
        startedAt,
      })
      const reserveOutcome = await Promise.race([
        reservePromise.then(
          (value) => ({ landed: true as const, value }),
          (error: unknown) => ({ error, landed: false as const }),
        ),
        admissionExpired,
      ])
      if (reserveOutcome === "deadline") {
        stopAdmissionTimer()
        // The reservation write cannot be cancelled and may still land, so it
        // would hold one of the two slots. Its late result is observed
        // detached — after the timeout answer is already out — and a landed
        // reservation is released by the guarded cleanup, whose own failure
        // leaves the lease as the bounded backstop.
        c.executionCtx.waitUntil(
          reservePromise.then(
            async (late) => {
              if (!late.reserved) return
              try {
                await releaseAiInvocationReservation(c.env.DB, requestId)
              } catch {
                // The lease releases the slot.
              }
            },
            (error: unknown) => {
              console.warn({
                event: "ai_admission_late_reserve_failed",
                message: error instanceof Error ? error.message : "unknown",
                requestId,
              })
            },
          ),
        )
        return problem("request-timeout", requestId)
      }
      if (!reserveOutcome.landed) {
        stopAdmissionTimer()
        return problem("service-unavailable", requestId)
      }
      const reserved = reserveOutcome.value
      if (!reserved.reserved) {
        stopAdmissionTimer()
        const response = problem("ai-concurrency-exceeded", requestId)
        response.headers.set("retry-after", "1")
        return response
      }

      /**
       * Gives the slot back for a request that never started. A release that
       * cannot land leaves the reservation to its lease, which is the same
       * bounded release the spec promises for late writes.
       */
      const abandonReservation = async (): Promise<void> => {
        try {
          await releaseAiInvocationReservation(c.env.DB, requestId)
        } catch {
          // The lease releases the slot; the response still tells the truth.
        }
      }

      // A reservation whose admission write landed after the budget is a late
      // result: it is released instead of starting the call. The release runs
      // detached, so a slow cleanup cannot block the timeout answer.
      if (Date.now() >= admissionDeadline) {
        stopAdmissionTimer()
        c.executionCtx.waitUntil(abandonReservation())
        return problem("request-timeout", requestId)
      }
      stopAdmissionTimer()

      const parsed = await readBoundedBody(c)
      if (!parsed.ok) {
        await abandonReservation()
        return parsed.response
      }
      const validated = validateResponsesRequest(parsed.body)
      if (!validated.ok) {
        await abandonReservation()
        return problem("validation-failed", requestId)
      }

      // Resolve the public model ID against the live catalog, then require
      // both the invoke operation and the exact model grant. Unknown and
      // ungranted models answer identically, so the endpoint is not a
      // catalog oracle.
      const parts = parseAiExternalModelId(validated.value.model)
      let connectionId: string | null = null
      let upstreamModelId: string | null = null
      let modelCapabilities: string | null = null
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
            const model = models.find(
              (candidate) =>
                candidate.upstreamModelId === parts.upstreamModelId,
            )
            if (model !== undefined) {
              connectionId = connection.id
              upstreamModelId = parts.upstreamModelId
              modelCapabilities = model.capabilities
            }
          }
        } catch {
          await abandonReservation()
          return problem("service-unavailable", requestId)
        }
      }
      if (
        connectionId === null ||
        upstreamModelId === null ||
        !authorizeAiInvocation(key.permissions, connectionId, upstreamModelId)
      ) {
        await abandonReservation()
        return problem("permission-denied", requestId)
      }

      // Capabilities are checked after the grant check, so an ungranted model
      // never reveals what its catalog entry declares. Unconfirmed capability
      // is never treated as support: the request is refused here, before any
      // upstream call.
      const capabilityCheck = validateAiRequestCapabilities({
        capabilities: modelCapabilities,
        request: validated.value,
      })
      if (!capabilityCheck.ok) {
        await abandonReservation()
        return problem("validation-failed", requestId)
      }

      // The reservation is identified only now: the slot was held from the
      // start, and a reservation that is already gone means the call must not
      // start.
      try {
        const assigned = await assignAiInvocationIdentity(c.env.DB, {
          connectionId,
          requestId,
          upstreamModelId,
        })
        if (!assigned.assigned) {
          await abandonReservation()
          return problem("service-unavailable", requestId)
        }
      } catch {
        await abandonReservation()
        return problem("service-unavailable", requestId)
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

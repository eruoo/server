import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import {
  API_KEY_EXPIRATION_HEADER,
  API_KEY_EXPIRATION_WARNING_WINDOW_MS,
} from "../../shared/api-key"
import { assertAuditSecret, scheduleAuditEvent } from "../audit"
import { inspectCredentialCarriers } from "../auth/carriers"
import { limitAuthEntry } from "../auth/entry-limit"
import { getRequestAuth, readOwnerSession } from "../auth/session"
import { errorResponse, problem, withReadDeadline } from "../http/response"
import type { AppBindings } from "../http/types"

export function registerStatusRoute(app: OpenAPIHono<AppBindings>) {
  const route = createRoute({
    method: "get",
    path: "/api/status",
    operationId: "getStatus",
    security: [{ ownerSession: [] }, { apiKey: [] }],
    responses: {
      default: errorResponse,
      200: {
        description: "Authenticated service status",
        content: {
          "application/json": {
            schema: z.object({ status: z.literal("ok") }).openapi("Status"),
          },
        },
      },
    },
  })
  app.openapi(route, async (c) => {
    const requestId = c.get("requestId")
    if (c.req.method !== "GET" || new URL(c.req.url).pathname !== route.path)
      return problem("not-found", requestId)
    const startedAt = Date.now()
    const inspection = inspectCredentialCarriers(c.req.raw)
    if (inspection.invalid) return problem("invalid-request", requestId)
    if (inspection.carriers[0] === "apiKey") {
      const limited = await limitAuthEntry(
        c,
        "GET /api/status",
        c.env.API_KEY_RATE_LIMITER,
      )
      if (limited) return limited
    }
    const remainingReadBudget = Math.max(0, 5000 - (Date.now() - startedAt))
    if (remainingReadBudget === 0) return problem("request-timeout", requestId)
    return withReadDeadline(
      (async () => {
        if (inspection.carriers[0] !== "apiKey") {
          const owner = await readOwnerSession(c)
          return owner instanceof Response
            ? owner
            : c.json({ status: "ok" as const }, 200, {
                "cache-control": "no-store",
              })
        }
        assertAuditSecret(c.env.AUDIT_IP_HASH_SECRET)
        const reject = (reason: string) =>
          scheduleAuditEvent(c, {
            type: reason === "expired" ? "api_key_expired" : "api_key_rejected",
            outcome: "failure",
            metadata: { reason },
          })
        try {
          const limited = () => {
            const response = problem("rate-limit-exceeded", requestId)
            response.headers.set("retry-after", "60")
            return response
          }
          const result = await getRequestAuth(c).api.verifyApiKey({
            body: { configId: "default", key: c.req.header("x-api-key")! },
          })
          if (!result.valid || !result.key) {
            const code = result.error?.code
            if (code === "RATE_LIMITED" || code === "USAGE_EXCEEDED")
              return limited()
            if (
              code &&
              [
                "INVALID_API_KEY",
                "KEY_DISABLED",
                "KEY_EXPIRED",
                "KEY_NOT_FOUND",
              ].includes(code)
            ) {
              reject(code === "KEY_EXPIRED" ? "expired" : "invalid_credential")
              return problem("invalid-credential", requestId)
            }
            reject("dependency_unavailable")
            return problem("service-unavailable", requestId)
          }
          const key = result.key
          const owner = await c.env.DB.prepare(
            "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1",
          )
            .bind(key.referenceId, c.env.OWNER_GITHUB_ID)
            .first()
          if (!owner) {
            reject("invalid_owner")
            return problem("invalid-credential", requestId)
          }
          if (!key.permissions?.status?.includes("read")) {
            reject("insufficient_permission")
            return problem("insufficient-permission", requestId)
          }
          if (
            !(key.expiresAt instanceof Date) ||
            !Number.isFinite(key.expiresAt.getTime())
          )
            return problem("service-unavailable", requestId)
          const remaining = key.expiresAt.getTime() - Date.now()
          if (remaining <= 0) {
            reject("expired")
            return problem("invalid-credential", requestId)
          }
          return c.json({ status: "ok" as const }, 200, {
            "cache-control": "no-store",
            ...(remaining <= API_KEY_EXPIRATION_WARNING_WINDOW_MS
              ? { [API_KEY_EXPIRATION_HEADER]: key.expiresAt.toISOString() }
              : {}),
          })
        } catch {
          reject("dependency_unavailable")
          return problem("service-unavailable", requestId)
        }
      })(),
      requestId,
      remainingReadBudget,
    )
  })
}

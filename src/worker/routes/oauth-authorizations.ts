import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

import { oauthClients } from "../../shared/oauth"
import {
  oauthAuthorizationListSchema,
  revokeOAuthAuthorizationSchema,
} from "../../shared/oauth-authorizations"
import { assertAuditSecret, scheduleAuditEvent } from "../audit"
import { limitAuthEntry } from "../auth/entry-limit"
import { readOwnerSession } from "../auth/session"
import {
  boundedRequest,
  errorResponse,
  problem,
  withReadDeadline,
} from "../http/response"
import type { AppBindings } from "../http/types"
import { listOAuthAuthorizations } from "../oauth/authorizations"
import { revokeClientFamilies } from "../oauth/families"
export function registerOAuthAuthorizations(app: OpenAPIHono<AppBindings>) {
  const path = "/api/oauth/authorizations"
  app.openapi(
    createRoute({
      method: "get",
      path,
      operationId: "listOAuthAuthorizations",
      security: [{ ownerSession: [] }],
      responses: {
        default: errorResponse,
        200: {
          description: "Static application authorizations",
          content: {
            "application/json": { schema: oauthAuthorizationListSchema },
          },
        },
      },
    }),
    async (c) => {
      if (c.req.method !== "GET" || new URL(c.req.url).pathname !== path)
        return problem("not-found", c.get("requestId"))
      return withReadDeadline(
        (async () => {
          const owner = await readOwnerSession(c)
          if (owner instanceof Response) return owner
          try {
            return c.json(
              await listOAuthAuthorizations(
                c.env.DB,
                owner.subject,
                Date.now(),
              ),
              200,
              { "cache-control": "private, no-store" },
            )
          } catch {
            return problem("service-unavailable", c.get("requestId"))
          }
        })(),
        c.get("requestId"),
      )
    },
  )
  app.openapi(
    createRoute({
      method: "delete",
      path: path + "/{clientId}",
      operationId: "revokeOAuthAuthorization",
      security: [{ ownerSession: [] }],
      request: { params: z.object({ clientId: z.string() }) },
      responses: {
        default: errorResponse,
        200: {
          description: "Revoked offline authorization",
          content: {
            "application/json": { schema: revokeOAuthAuthorizationSchema },
          },
        },
      },
    }),
    async (c) => {
      const requestId = c.get("requestId")
      const clientId = c.req.valid("param").clientId
      if (new URL(c.req.url).pathname !== `${path}/${clientId}`)
        return problem("not-found", requestId)
      if (c.req.header("origin") !== c.env.APP_ORIGIN)
        return problem("permission-denied", requestId)
      const request = await boundedRequest(c.req.raw)
      if (!request) return problem("payload-too-large", requestId)
      c.req.raw = request
      assertAuditSecret(c.env.AUDIT_IP_HASH_SECRET)
      const limited = await limitAuthEntry(c, "revoke-grant")
      if (limited) return limited
      const owner = await readOwnerSession(c, true)
      if (owner instanceof Response) return owner
      const client = oauthClients.find((value) => value.clientId === clientId)
      if (!client) return problem("not-found", requestId)
      if (!client.enabled || !client.supportsOfflineAccess)
        return problem("permission-denied", requestId)
      const result = await revokeClientFamilies(
        c.env.DB,
        owner.subject,
        clientId,
      )
      if (result.revokedRefreshTokenCount + result.deletedConsentCount === 0)
        return problem("not-found", requestId)
      scheduleAuditEvent(c, {
        type: "oauth_grant_revoked",
        outcome: "success",
        subjectId: owner.subject,
        clientId,
        metadata: result,
      })
      return c.json({ ...result, clientId: client.clientId }, 200, {
        "cache-control": "private, no-store",
      })
    },
  )
}

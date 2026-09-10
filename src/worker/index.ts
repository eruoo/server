import { OpenAPIHono } from "@hono/zod-openapi"

import { assertAuditSecret, scheduleAuditEvent } from "./audit"
import type { AuditEventType } from "./audit"
import { limitAuthEntry } from "./auth/entry-limit"
import { authOperations, loginErrors } from "./auth/routes"
import { getRequestAuth, readOwnerSession } from "./auth/session"
import { isProblemSlug, problemTypeRegistry } from "./http/problem-registry"
import { boundedRequest, problem, withReadDeadline } from "./http/response"
import type { AppBindings } from "./http/types"
import { handleOAuthRequest, oauthOperations } from "./oauth/handler"
import {
  serveOAuthMetadata,
  serveProtectedResourceMetadata,
} from "./oauth/protocol"
import { registerApplicationRoutes } from "./routes"
import { runScheduledMaintenance } from "./schedules"

export const app = new OpenAPIHono<AppBindings>()

app.use(async (c, next) => {
  c.set("requestId", crypto.randomUUID())
  c.set("responseCookies", [])
  await next()
  if (c.res.status !== 504)
    for (const cookie of c.get("responseCookies"))
      c.header("set-cookie", cookie, { append: true })
  c.header("x-request-id", c.get("requestId"))
  c.header("x-content-type-options", "nosniff")
  c.header("referrer-policy", "no-referrer")
  c.header(
    "content-security-policy",
    `default-src 'self'; script-src 'self'; style-src 'self'${new URL(c.req.url).pathname === "/api/docs" ? " 'unsafe-inline'" : ""}; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  )
  if (c.env.APP_ORIGIN === "https://auth.eruoo.me")
    c.header("strict-transport-security", "max-age=31536000; includeSubDomains")
})

app.onError((_error, c) => {
  console.error(
    JSON.stringify({
      event: "request_failed",
      requestId: c.get("requestId"),
      status: 503,
    }),
  )
  return problem("service-unavailable", c.get("requestId"))
})

app.get("/health", (c) =>
  c.req.method !== "GET"
    ? problem("not-found", c.get("requestId"))
    : c.json(
        {
          ok: true,
          service: "eruoo-server",
          milestone: "R5",
          version: c.env.CF_VERSION_METADATA?.id,
          time: new Date().toISOString(),
        },
        200,
        { "cache-control": "no-store" },
      ),
)

app.get("/problems/:slug", (c) => {
  const slug = c.req.param("slug")
  if (c.req.method !== "GET" || !isProblemSlug(slug))
    return problem("not-found", c.get("requestId"))
  return c.text(
    `${problemTypeRegistry[slug].title}\n\n${problemTypeRegistry[slug].description}`,
  )
})

app.all("/api/auth/*", async (c) => {
  const requestId = c.get("requestId")
  const path = new URL(c.req.url).pathname
  if (c.req.method === "GET" && path === "/api/auth/error") {
    const error = c.req.query("error") ?? ""
    return new Response(null, {
      status: 302,
      headers: {
        location: `/login?error=${loginErrors.has(error) ? error : "service_unavailable"}`,
        "cache-control": "no-store",
      },
    })
  }
  const operation = authOperations.get(`${c.req.method} ${path}`)
  const isOAuth = oauthOperations.has(`${c.req.method} ${path}`)
  if (!operation && !isOAuth) return problem("not-found", requestId)
  const request = await boundedRequest(c.req.raw)
  if (!request)
    return isOAuth
      ? Response.json(
          { error: "invalid_request" },
          { status: 400, headers: { "cache-control": "no-store" } },
        )
      : problem("payload-too-large", requestId)
  c.req.raw = request
  if (isOAuth) return handleOAuthRequest(c)
  if (!operation) return problem("not-found", requestId)
  if (
    request.method === "POST" &&
    request.headers.get("origin") !== c.env.APP_ORIGIN
  ) {
    return problem("permission-denied", requestId)
  }
  if (
    request.method === "POST" &&
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return problem("unsupported-media-type", requestId)
  }
  if (operation.limited || operation.owner)
    assertAuditSecret(c.env.AUDIT_IP_HASH_SECRET)
  if (
    operation.owner === "recent" &&
    request.headers.get("origin") !== c.env.APP_ORIGIN &&
    !(
      request.method === "GET" &&
      !request.headers.has("origin") &&
      request.headers.get("sec-fetch-site") === "same-origin" &&
      new URL(request.url).origin === c.env.APP_ORIGIN
    )
  )
    return problem("permission-denied", requestId)
  if (operation.limited) {
    const limited = await limitAuthEntry(c, `${c.req.method} ${path}`)
    if (limited) return limited
  }
  const response = (async () => {
    if (operation.owner) {
      const principal = await readOwnerSession(c, operation.owner === "recent")
      if (principal instanceof Response) {
        if (operation.owner === "recent")
          scheduleAuditEvent(c, {
            type: "sensitive_operation_denied",
            outcome: "failure",
            metadata: { status: principal.status },
          })
        return principal
      }
    }
    if (
      path === "/api/auth/api-key/create" ||
      path === "/api/auth/api-key/update"
    ) {
      let body: unknown
      try {
        body = await request.clone().json()
      } catch {
        return problem("invalid-request", requestId)
      }
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return problem("validation-failed", requestId)
      const allowedFields = path.endsWith("/update")
        ? ["keyId", "name"]
        : ["name", "expiresIn"]
      if (Object.keys(body).some((field) => !allowedFields.includes(field)))
        return problem("validation-failed", requestId)
      if (
        "expiresIn" in body &&
        (typeof body.expiresIn !== "number" ||
          !Number.isInteger(body.expiresIn) ||
          body.expiresIn < 86400 ||
          body.expiresIn > 365 * 86400)
      )
        return problem("api-key-expiration-required", requestId)
    }
    const response = await getRequestAuth(c).handler(request)
    const events: Record<string, AuditEventType> = {
      "/api/auth/api-key/create": "api_key_created",
      "/api/auth/api-key/update": "api_key_updated",
      "/api/auth/api-key/delete": "api_key_revoked",
      "/api/auth/callback/github": "github_login",
      "/api/auth/passkey/verify-authentication": "passkey_login",
      "/api/auth/passkey/verify-registration": "passkey_created",
      "/api/auth/passkey/update-passkey": "passkey_updated",
      "/api/auth/passkey/delete-passkey": "passkey_deleted",
    }
    const event = events[path]
    if (event && response.status !== 429) {
      const failed =
        response.status >= 400 ||
        new URL(
          response.headers.get("location") ?? "/",
          c.env.APP_ORIGIN,
        ).searchParams.has("error")
      scheduleAuditEvent(c, {
        type: event,
        outcome: failed ? "failure" : "success",
        subjectId: c.get("principal")?.subject,
        metadata: { status: response.status },
      })
    }
    return response.status >= 500
      ? problem("service-unavailable", requestId)
      : response
  })().catch(() => problem("service-unavailable", requestId))
  return operation.read ? withReadDeadline(response, requestId) : response
})

for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource/api",
])
  app.all(path, (c) => {
    if (
      !["GET", "HEAD"].includes(c.req.method) ||
      new URL(c.req.url).pathname !== path
    )
      return problem("not-found", c.get("requestId"))
    return path.endsWith("/api")
      ? serveProtectedResourceMetadata(c)
      : serveOAuthMetadata(c)
  })

registerApplicationRoutes(app)

app.notFound((c) => problem("not-found", c.get("requestId")))

export default {
  fetch: (request: Request, env, context) => app.fetch(request, env, context),
  scheduled: async (controller, env) => {
    await runScheduledMaintenance(controller, env)
  },
} satisfies ExportedHandler<Env>

export { DatabaseBackupWorkflow } from "./workflows/database-backup"

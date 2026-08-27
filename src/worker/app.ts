import { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { secureHeaders } from "hono/secure-headers"
import { timeout } from "hono/timeout"

import type { AuditEventType, AuditOutcome } from "./audit"
import { assertAuditSecret, scheduleAuditEvent } from "./audit"
import { getInitializedAuth } from "./auth"
import {
  captureOAuthProtocolAudit,
  scheduleOAuthProtocolAudit,
} from "./auth/oauth-audit"
import {
  oauthMetadataPaths,
  oauthTokenRequestBodyTooLarge,
  oauthTokenServiceUnavailable,
  serveOAuthMetadata,
  serveProtectedResourceMetadata,
  validateOAuthAuthorizationRequest,
  validateOAuthRevocationRequest,
  validateOAuthTokenRequest,
  validateOAuthUserInfoRequest,
} from "./auth/oauth-protocol"
import { enforceOAuthRefreshFamilyRevocation } from "./auth/oauth-refresh-revocation"
import { authRateLimit } from "./auth/rate-limit"
import { requireOwnerSession, requireRecentOwnerSession } from "./auth/session"
import { configuredCors } from "./http/cors"
import { configuredCsrf } from "./http/csrf"
import { problem } from "./http/problem"
import { requestId } from "./http/request-id"
import type { AppBindings } from "./http/types"
import { createOpenApiDocument } from "./openapi"
import { createApiDocumentationRouter } from "./routes/api-documentation"
import { auditEventsRouter } from "./routes/audit"
import { backupStatusRouter } from "./routes/backup-status"
import { oauthAuthorizationsRouter } from "./routes/oauth-authorizations"
import { problemsRouter } from "./routes/problems"
import { statusRouter } from "./routes/status"

const sensitiveAuthPaths = [
  "/api/auth/api-key/create",
  "/api/auth/api-key/delete",
  "/api/auth/api-key/update",
  "/api/auth/passkey/delete-passkey",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/update-passkey",
  "/api/auth/passkey/verify-registration",
] as const

const ownerOnlyAuthPaths = [
  "/api/auth/api-key/get",
  "/api/auth/api-key/list",
  "/api/auth/passkey/list-user-passkeys",
] as const

const auditedAuthPaths = new Map<string, AuditEventType>([
  ["/api/auth/api-key/create", "api_key_created"],
  ["/api/auth/api-key/delete", "api_key_revoked"],
  ["/api/auth/api-key/update", "api_key_updated"],
  ["/api/auth/callback/github", "github_login"],
  ["/api/auth/passkey/delete-passkey", "passkey_deleted"],
  ["/api/auth/passkey/update-passkey", "passkey_updated"],
  ["/api/auth/passkey/verify-authentication", "passkey_login"],
  ["/api/auth/passkey/verify-registration", "passkey_created"],
])

const safeReadTimeout = timeout(
  15_000,
  new HTTPException(504, { message: "The request timed out." }),
)

export function usesApplicationTimeout(method: string, path: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/auth/")
  )
}

async function configuredApplicationTimeout(
  context: Context<AppBindings>,
  next: () => Promise<void>,
) {
  if (!usesApplicationTimeout(context.req.method, context.req.path)) {
    return next()
  }

  return safeReadTimeout(context, next)
}

async function requireValidAuditConfiguration(
  context: Context<AppBindings>,
  next: () => Promise<void>,
) {
  assertAuditSecret(context.env.AUDIT_IP_HASH_SECRET)
  return next()
}

function rejectClientApiKeyPermissions(
  eventType: "api_key_created" | "api_key_updated",
) {
  return async (context: Context<AppBindings>, next: () => Promise<void>) => {
    let body: unknown

    try {
      body = await context.req.raw.clone().json()
    } catch {
      await next()
      return
    }

    if (
      typeof body === "object" &&
      body !== null &&
      Object.hasOwn(body, "permissions")
    ) {
      scheduleAuditEvent(context, {
        outcome: "failure",
        subjectId: context.var.principal.subject,
        type: eventType,
      })

      return problem(context, {
        detail: "The API key permissions are not allowed.",
        slug: "insufficient-permission",
      })
    }

    await next()
  }
}

const allowedBetterAuthOperations = new Set([
  "GET /api/auth/callback/github",
  "GET /api/auth/get-session",
  "GET /api/auth/jwks",
  "GET /api/auth/oauth2/authorize",
  "GET /api/auth/oauth2/end-session",
  "GET /api/auth/oauth2/userinfo",
  "GET /api/auth/api-key/get",
  "GET /api/auth/api-key/list",
  "GET /api/auth/passkey/generate-authenticate-options",
  "GET /api/auth/passkey/generate-register-options",
  "GET /api/auth/passkey/list-user-passkeys",
  "POST /api/auth/api-key/create",
  "POST /api/auth/api-key/delete",
  "POST /api/auth/api-key/update",
  "POST /api/auth/oauth2/authorize",
  "POST /api/auth/oauth2/consent",
  "POST /api/auth/oauth2/continue",
  "POST /api/auth/oauth2/end-session",
  "POST /api/auth/oauth2/end-session/confirm",
  "POST /api/auth/oauth2/introspect",
  "POST /api/auth/oauth2/revoke",
  "POST /api/auth/oauth2/token",
  "POST /api/auth/oauth2/userinfo",
  "POST /api/auth/passkey/delete-passkey",
  "POST /api/auth/passkey/update-passkey",
  "POST /api/auth/passkey/verify-authentication",
  "POST /api/auth/passkey/verify-registration",
  "POST /api/auth/sign-in/social",
  "POST /api/auth/sign-out",
])

async function betterAuthRouteGate(
  context: Context<AppBindings>,
  next: () => Promise<void>,
) {
  const operation = `${context.req.method} ${context.req.path}`

  if (!allowedBetterAuthOperations.has(operation)) {
    return context.json({ message: "Not found" }, 404, {
      "Cache-Control": "no-store",
    })
  }

  return next()
}

async function rejectImplicitCustomApiHead(
  context: Context<AppBindings>,
  next: () => Promise<void>,
) {
  const isBetterAuthPath =
    context.req.path === "/api/auth" ||
    context.req.path.startsWith("/api/auth/")

  if (context.req.method === "HEAD" && !isBetterAuthPath) {
    return problem(context, {
      detail: "The requested API operation does not exist.",
      slug: "not-found",
    })
  }

  return next()
}

function authOutcome(
  eventType: AuditEventType,
  response: Response,
): AuditOutcome {
  const location = response.headers.get("location")
  if (location) {
    try {
      if (
        new URL(location, "https://auth.eruoo.me").searchParams.has("error")
      ) {
        return "failure"
      }
    } catch {
      return "failure"
    }
  }

  if (eventType === "github_login" || eventType === "passkey_login") {
    const setCookie = response.headers.get("set-cookie") ?? ""
    const createdSession =
      /(?:^|[,;]\s*)(?:__Secure-)?eruoo\.session_token=/.test(setCookie)

    return response.status < 400 && createdSession ? "success" : "failure"
  }

  return response.status < 400 ? "success" : "failure"
}

export function createApp() {
  const app = new OpenAPIHono<AppBindings>({
    defaultHook: (result, context) => {
      if (result.success) {
        return
      }

      return problem(context, {
        detail: "The request does not satisfy the operation contract.",
        errors: result.error.issues.map((issue) => ({
          detail: issue.message,
          location:
            result.target === "param"
              ? "path"
              : result.target === "header"
                ? "header"
                : result.target === "query"
                  ? "query"
                  : "body",
          pointer: `/${issue.path.map(String).join("/")}`,
        })),
        slug: "validation-failed",
      })
    },
    strict: true,
  })

  app.use("*", requestId)
  app.use("*", secureHeaders())
  app.use("*", requireValidAuditConfiguration)
  app.use("/api/auth/*", async (context, next) => {
    await next()
    context.header("Cache-Control", "no-store")
  })
  app.use("*", configuredCors)
  app.use("/api", rejectImplicitCustomApiHead)
  app.use("/api/*", rejectImplicitCustomApiHead)
  app.use("/api/auth", betterAuthRouteGate)
  app.use("/api/auth/*", betterAuthRouteGate)
  app.use("/api/auth/*", authRateLimit)
  app.use("/api/oauth/authorizations/:clientId", authRateLimit)
  app.use("/api/*", configuredCsrf)
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (context) => {
        const appContext = context as Context<AppBindings>
        return appContext.req.path === "/api/auth/oauth2/token"
          ? oauthTokenRequestBodyTooLarge(appContext)
          : problem(appContext, {
              detail: "The request body exceeds the 1 MiB limit.",
              slug: "payload-too-large",
            })
      },
    }),
  )
  app.use("/api/*", configuredApplicationTimeout)

  for (const path of sensitiveAuthPaths) {
    app.use(path, requireRecentOwnerSession)
  }

  app.use("/api/auth/api-key/update", async (context, next) => {
    let body: unknown

    try {
      body = await context.req.raw.clone().json()
    } catch {
      await next()
      return
    }

    if (
      typeof body === "object" &&
      body !== null &&
      "expiresIn" in body &&
      body.expiresIn === null
    ) {
      scheduleAuditEvent(context, {
        outcome: "failure",
        subjectId: context.var.principal.subject,
        type: "api_key_updated",
      })

      return problem(context, {
        detail: "API keys must always have a finite expiration time.",
        slug: "api-key-expiration-required",
      })
    }

    await next()
  })
  app.use(
    "/api/auth/api-key/create",
    rejectClientApiKeyPermissions("api_key_created"),
  )
  app.use(
    "/api/auth/api-key/update",
    rejectClientApiKeyPermissions("api_key_updated"),
  )

  for (const path of ownerOnlyAuthPaths) {
    app.use(path, requireOwnerSession)
  }

  app.use("/api/auth/oauth2/authorize", validateOAuthAuthorizationRequest)
  app.use("/api/auth/oauth2/revoke", validateOAuthRevocationRequest)
  app.use("/api/auth/oauth2/revoke", enforceOAuthRefreshFamilyRevocation)
  app.use("/api/auth/oauth2/token", validateOAuthTokenRequest)
  app.use("/api/auth/oauth2/token", enforceOAuthRefreshFamilyRevocation)
  app.use("/api/auth/oauth2/userinfo", validateOAuthUserInfoRequest)

  for (const path of oauthMetadataPaths) {
    app.on(["GET", "HEAD"], path, serveOAuthMetadata)
  }
  app.on(
    ["GET", "HEAD"],
    "/.well-known/oauth-protected-resource/api",
    serveProtectedResourceMetadata,
  )

  app.route("/", problemsRouter)
  app.route(
    "/",
    createApiDocumentationRouter(() => createOpenApiDocument(app)),
  )
  app.route("/", auditEventsRouter)
  app.route("/", backupStatusRouter)
  app.route("/", oauthAuthorizationsRouter)
  app.route("/", statusRouter)

  app.all("/api/auth/api-key/verify", (context) =>
    context.json({ message: "Not found" }, 404, {
      "Cache-Control": "no-store",
    }),
  )

  app.all("/api/auth/*", async (context) => {
    const oauthAudit = await captureOAuthProtocolAudit(context)
    const auth = await getInitializedAuth(context.env)
    const response = await auth.handler(context.req.raw)
    scheduleOAuthProtocolAudit(context, oauthAudit, response)
    const eventType = auditedAuthPaths.get(context.req.path)

    if (eventType && response.status !== 429) {
      scheduleAuditEvent(context, {
        outcome: authOutcome(eventType, response),
        ...(context.var.principal
          ? { subjectId: context.var.principal.subject }
          : {}),
        type: eventType,
      })
    }

    return response
  })

  app.notFound((context) => {
    if (context.req.path === "/api" || context.req.path.startsWith("/api/")) {
      return problem(context, {
        detail: "The requested API operation does not exist.",
        slug: "not-found",
      })
    }

    return context.body(null, 404)
  })

  app.onError(handleAppError)

  app.openAPIRegistry.registerComponent("securitySchemes", "ownerSession", {
    description: "Better Auth owner Session cookie.",
    in: "cookie",
    name: "__Secure-eruoo.session_token",
    type: "apiKey",
  })
  app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
    description: "Finite Better Auth API key with route-scoped permissions.",
    in: "header",
    name: "x-api-key",
    type: "apiKey",
  })

  return app
}

export function handleAppError(
  error: Error,
  context: Context<AppBindings>,
): Response {
  const exceptionStatus = error instanceof HTTPException ? error.status : 500
  const tokenRequestTimedOut =
    exceptionStatus === 504 && context.req.path === "/api/auth/oauth2/token"
  const status = tokenRequestTimedOut ? 503 : exceptionStatus

  console.error({
    event: "request_failed",
    error: error.name,
    requestId: context.get("requestId"),
    status,
  })

  if (tokenRequestTimedOut) {
    return oauthTokenServiceUnavailable(context)
  }

  if (context.req.path.startsWith("/api/auth/")) {
    return context.json(
      {
        message:
          status === 504 ? "The request timed out." : "Authentication failed.",
      },
      status,
      { "Cache-Control": "no-store" },
    )
  }

  if (status === 403) {
    return problem(context, {
      detail: "The request was rejected by the request security policy.",
      slug: "permission-denied",
    })
  }

  return problem(context, {
    detail:
      status === 504
        ? "The request exceeded the service time limit."
        : "The request could not be completed.",
    slug: status === 504 ? "request-timeout" : "internal-error",
  })
}

import { OpenAPIHono } from "@hono/zod-openapi"
import type { Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { secureHeaders } from "hono/secure-headers"
import { timeout } from "hono/timeout"

import type { AuditEventType, AuditOutcome } from "./audit"
import { assertAuditSecret, scheduleAuditEvent } from "./audit"
import { getInitializedAuth, type Auth } from "./auth"
import { sessionCookieNames } from "./auth/carriers"
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

const oauthAuthoritativeSessionPaths = new Set([
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue",
])

/**
 * 提取 Cookie pair 的名字并去除首尾空白，语义与 Better Auth 内部
 * `parseCookies` 的 `trimOWS` 一致——RFC 6265 允许 `=` 两侧空白，若实现
 * 不一致会导致 `eruoo.session_token = <value>` 绕过本层检测。
 */
function sessionCookieName(pair: string): string | undefined {
  const separator = pair.indexOf("=")
  if (separator < 1) return undefined
  const name = pair.slice(0, separator).trim()
  return name.length === 0 ? undefined : name
}

/**
 * OAuth 授权码签发路径由 oauth-provider 插件内部完成 Session 校验。插件对
 * GET 从 URL query、对 POST 从表单 body 重建参数并整体覆盖 `ctx.query`，
 * 因此不能依赖 URL 注入 `disableCookieCache`。改为在 Hono 层先做权威
 * `getSession`（绕过 30s cookie 缓存）：权威有效才放行；权威无效则剥掉
 * Session cookie 再交给插件，让插件走未登录流程（authorize 跳登录页，
 * consent/continue 拒绝），从而保证已撤销 Session 在缓存窗口内无法签发
 * 新授权码。权威读取返回的 Set-Cookie 清理头（失效 Session 的删除指令）
 * 必须随最终响应回传，否则浏览器保留旧缓存，SPA 会误判已登录。
 */
async function enforceAuthoritativeOAuthSession(
  request: Request,
  auth: Auth,
): Promise<{
  authoritativeClearingCookies?: string[]
  request: Request
}> {
  const cookieHeader = request.headers.get("cookie")
  if (!cookieHeader) return { request }

  const hasSessionCookie = cookieHeader.split(";").some((pair) => {
    const name = sessionCookieName(pair)
    return name !== undefined && sessionCookieNames.has(name)
  })

  if (!hasSessionCookie) return { request }

  const result = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  })
  if (result.response) return { request }

  const headers = new Headers(request.headers)
  headers.set(
    "cookie",
    cookieHeader
      .split(";")
      .filter((pair) => {
        const name = sessionCookieName(pair)
        return name === undefined || !sessionCookieNames.has(name)
      })
      .join("; "),
  )
  return {
    authoritativeClearingCookies: result.headers.getSetCookie(),
    request: new Request(request, { headers }),
  }
}

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
  5_000,
  new HTTPException(504, { message: "The request timed out." }),
)

export function usesApplicationTimeout(
  method: string,
  path: string,
  headers: Headers,
): boolean {
  if (method === "GET" && path === "/api/auth/get-session") return true
  if (method === "GET" && path === "/api/status" && headers.has("x-api-key")) {
    return false
  }

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
  if (
    !usesApplicationTimeout(
      context.req.method,
      context.req.path,
      context.req.raw.headers,
    )
  ) {
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

    // OAuth 授权码签发路径必须绕过 30s cookie 缓存做权威读取：GET/POST
    // 统一在 Hono 层预检，权威失效的 Session cookie 在交给插件前剥离。
    const authoritative = oauthAuthoritativeSessionPaths.has(context.req.path)
      ? await enforceAuthoritativeOAuthSession(context.req.raw, auth)
      : undefined

    const response = await auth.handler(
      authoritative?.request ?? context.req.raw,
    )

    // 权威预检发现 Session 失效时，Better Auth 生成了对应的
    // Set-Cookie 清理指令；如果丢弃，浏览器会保留旧缓存 cookie，
    // SPA 下一次 get-session 仍命中缓存并误判为已登录。
    if (authoritative?.authoritativeClearingCookies) {
      for (const setCookie of authoritative.authoritativeClearingCookies) {
        response.headers.append("set-cookie", setCookie)
      }
    }

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

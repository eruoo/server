import type { MiddlewareHandler } from "hono"

import { API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS } from "../../shared/api-key"
import { problem } from "../http/problem"
import type { AppBindings } from "../http/types"

export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60
export const API_KEY_STATUS_RATE_LIMIT_PATH = "/api/status:api-key"
export const RATE_LIMIT_DEPENDENCY_TIMEOUT_MS = 5_000
export const OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH =
  "/api/oauth/authorizations/:clientId"

export const HIGH_RISK_AUTH_PATHS = [
  "/api/auth/api-key/create",
  "/api/auth/api-key/delete",
  "/api/auth/api-key/update",
  "/api/auth/callback/github",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/consent",
  "/api/auth/oauth2/continue",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/token",
  "/api/auth/passkey/delete-passkey",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/update-passkey",
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/verify-registration",
  "/api/auth/sign-in/social",
  OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH,
] as const

const highRiskAuthPathSet: ReadonlySet<string> = new Set(HIGH_RISK_AUTH_PATHS)
const oauthAuthorizationRevocationPathPattern =
  /^\/api\/oauth\/authorizations\/[^/]+$/

export function resolveAuthRateLimitPath(path: string): string | undefined {
  if (highRiskAuthPathSet.has(path)) return path

  return oauthAuthorizationRevocationPathPattern.test(path)
    ? OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH
    : undefined
}

export function isHighRiskAuthPath(path: string): boolean {
  return resolveAuthRateLimitPath(path) !== undefined
}

export function resolveAuthRateLimitRequestPath(
  method: string,
  path: string,
): string | undefined {
  const resolvedPath = resolveAuthRateLimitPath(path)

  if (
    resolvedPath === OAUTH_AUTHORIZATION_REVOCATION_RATE_LIMIT_PATH &&
    method !== "DELETE"
  ) {
    return undefined
  }

  return resolvedPath
}

interface RateLimitMessages {
  dependencyEvent: string
  dependencyFailureDetail: string
  rejectionDetail: string
}

const authenticationRateLimitMessages: RateLimitMessages = {
  dependencyEvent: "auth_rate_limit_dependency_failed",
  dependencyFailureDetail: "The authentication rate limiter is unavailable.",
  rejectionDetail: "Too many authentication requests were received.",
}

const apiKeyStatusRateLimitMessages: RateLimitMessages = {
  dependencyEvent: "api_key_status_rate_limit_dependency_failed",
  dependencyFailureDetail: "The API key request limiter is unavailable.",
  rejectionDetail: "Too many API key requests were received.",
}

async function checkRateLimitBeforeDeadline(
  limiter: RateLimit,
  key: string,
): Promise<RateLimitOutcome> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      limiter.limit({ key }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new DOMException(
              "The rate limiter dependency timed out.",
              "TimeoutError",
            ),
          )
        }, RATE_LIMIT_DEPENDENCY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

async function enforceRateLimit(
  context: Parameters<MiddlewareHandler<AppBindings>>[0],
  next: Parameters<MiddlewareHandler<AppBindings>>[1],
  limiter: RateLimit,
  rateLimitPath: string,
  messages: RateLimitMessages,
  windowSeconds: number,
): Promise<Response | void> {
  let outcome: RateLimitOutcome

  try {
    const ipAddress = context.req.header("CF-Connecting-IP") ?? "unknown"
    outcome = await checkRateLimitBeforeDeadline(
      limiter,
      `${rateLimitPath}:${ipAddress}`,
    )
  } catch (error) {
    console.error({
      error: error instanceof Error ? error.name : "unknown_error",
      event: messages.dependencyEvent,
      path: context.req.path,
      requestId: context.get("requestId"),
    })

    return problem(context, {
      detail: messages.dependencyFailureDetail,
      slug: "service-unavailable",
    })
  }

  if (outcome.success) {
    await next()
    return
  }

  const response = problem(context, {
    detail: messages.rejectionDetail,
    slug: "rate-limit-exceeded",
  })
  response.headers.set("Retry-After", String(windowSeconds))
  return response
}

export const authRateLimit: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const rateLimitPath = resolveAuthRateLimitRequestPath(
    context.req.method,
    context.req.path,
  )

  if (context.req.method === "OPTIONS" || rateLimitPath === undefined) {
    await next()
    return
  }

  return enforceRateLimit(
    context,
    next,
    context.env.AUTH_RATE_LIMITER,
    rateLimitPath,
    authenticationRateLimitMessages,
    AUTH_RATE_LIMIT_WINDOW_SECONDS,
  )
}

export const apiKeyStatusRateLimit: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  if (
    context.req.method !== "GET" ||
    context.req.path !== "/api/status" ||
    context.req.header("x-api-key") === undefined
  ) {
    await next()
    return
  }

  return enforceRateLimit(
    context,
    next,
    context.env.API_KEY_RATE_LIMITER,
    API_KEY_STATUS_RATE_LIMIT_PATH,
    apiKeyStatusRateLimitMessages,
    API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS,
  )
}

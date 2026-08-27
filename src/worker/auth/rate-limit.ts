import type { MiddlewareHandler } from "hono"

import { problem } from "../http/problem"
import type { AppBindings } from "../http/types"

export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60
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

export const authRateLimit: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const path = context.req.path
  const rateLimitPath = resolveAuthRateLimitRequestPath(
    context.req.method,
    path,
  )

  if (context.req.method === "OPTIONS" || rateLimitPath === undefined) {
    await next()
    return
  }

  try {
    const ipAddress = context.req.header("CF-Connecting-IP") ?? "unknown"
    const outcome = await context.env.AUTH_RATE_LIMITER.limit({
      key: `${rateLimitPath}:${ipAddress}`,
    })

    if (outcome.success) {
      await next()
      return
    }
  } catch (error) {
    console.error({
      error: error instanceof Error ? error.name : "unknown_error",
      event: "auth_rate_limit_dependency_failed",
      path,
      requestId: context.get("requestId"),
    })

    return problem(context, {
      detail: "The authentication rate limiter is unavailable.",
      slug: "service-unavailable",
    })
  }

  const response = problem(context, {
    detail: "Too many authentication requests were received.",
    slug: "rate-limit-exceeded",
  })
  response.headers.set("Retry-After", String(AUTH_RATE_LIMIT_WINDOW_SECONDS))
  return response
}

import type { MiddlewareHandler } from "hono"
import { cors } from "hono/cors"

import { API_KEY_EXPIRATION_HEADER } from "../../shared/api-key"
import { getRuntimeConfig } from "../config"
import type { AppBindings } from "./types"

function requestedOperation(context: Parameters<MiddlewareHandler>[0]): string {
  const method =
    context.req.method === "OPTIONS"
      ? context.req.header("access-control-request-method")
      : context.req.method

  return `${method?.toUpperCase() ?? ""} ${context.req.path}`
}

function allowedMethodsByPath(
  allowedOperations: ReadonlySet<string>,
): ReadonlyMap<string, string[]> {
  const methodsByPath = new Map<string, Set<string>>()

  for (const operation of allowedOperations) {
    const separatorIndex = operation.indexOf(" ")
    const method = operation.slice(0, separatorIndex)
    const path = operation.slice(separatorIndex + 1)
    if (separatorIndex < 1 || path.length === 0) {
      throw new TypeError(`Invalid CORS operation ${operation}.`)
    }

    const methods = methodsByPath.get(path) ?? new Set<string>()
    methods.add(method)
    methodsByPath.set(path, methods)
  }

  return new Map(
    [...methodsByPath].map(([path, methods]) => [
      path,
      [...methods, ...(methods.has("OPTIONS") ? [] : ["OPTIONS"])],
    ]),
  )
}

export function createConfiguredCors(
  allowedOperations: ReadonlySet<string>,
  apiKeyOperations: ReadonlySet<string> = new Set(),
): MiddlewareHandler<AppBindings> {
  const methodsByPath = allowedMethodsByPath(allowedOperations)

  for (const operation of apiKeyOperations) {
    if (!allowedOperations.has(operation)) {
      throw new TypeError(
        `API key CORS operation ${operation} must also be allowlisted.`,
      )
    }
  }

  return async (context, next) => {
    const operation = requestedOperation(context)
    if (!allowedOperations.has(operation)) {
      await next()
      return
    }

    const config = getRuntimeConfig(context.env)
    const isApiKeyOperation = apiKeyOperations.has(operation)
    const allowMethods = methodsByPath.get(context.req.path)
    if (!allowMethods) {
      throw new TypeError(`Missing CORS methods for ${context.req.path}.`)
    }

    const middleware = cors({
      allowHeaders: [
        "Authorization",
        "Content-Type",
        ...(isApiKeyOperation ? ["X-API-Key"] : []),
        "X-Request-ID",
      ],
      allowMethods,
      credentials: false,
      exposeHeaders: [
        ...(isApiKeyOperation
          ? [API_KEY_EXPIRATION_HEADER, "Retry-After"]
          : []),
        "X-Request-ID",
      ],
      maxAge: 600,
      origin: (origin) =>
        config.allowedCorsOrigins.has(origin) ? origin : undefined,
    })

    return middleware(context, next)
  }
}

const crossOriginProtocolOperations = new Set([
  "GET /.well-known/oauth-authorization-server",
  "GET /.well-known/openid-configuration",
  "GET /.well-known/oauth-protected-resource/api",
  "HEAD /.well-known/oauth-authorization-server",
  "HEAD /.well-known/openid-configuration",
  "HEAD /.well-known/oauth-protected-resource/api",
  "GET /api/auth/jwks",
  "GET /api/auth/oauth2/userinfo",
  "GET /api/status",
  "POST /api/auth/oauth2/revoke",
  "POST /api/auth/oauth2/token",
  "POST /api/auth/oauth2/userinfo",
])

export const configuredCors = createConfiguredCors(
  crossOriginProtocolOperations,
  new Set(["GET /api/status"]),
)

import type { MiddlewareHandler } from "hono"

import { enabledOAuthClientIds, OAUTH_RESOURCE } from "../../shared/oauth"
import type { Principal } from "../../shared/principal"
import { getRuntimeConfig } from "../config"
import { problem } from "../http/problem"
import type { AppBindings } from "../http/types"
import {
  hasUnsupportedBodyAccessToken,
  inspectCredentialCarriers,
} from "./carriers"
import {
  OAUTH_ACCESS_TOKEN_PRODUCTION_CLOCK_TOLERANCE_SECONDS,
  verifyOAuthAccessToken,
} from "./oauth-access-token"
import {
  createD1OAuthJwksResolver,
  OAuthJwksDependencyError,
} from "./oauth-jwks"

type NonEmptyScopes = readonly [string, ...string[]]
const enabledClientIds: ReadonlySet<string> = enabledOAuthClientIds

function bearerChallenge(
  appOrigin: string,
  error?: "insufficient_scope" | "invalid_request" | "invalid_token",
  scopes?: readonly string[],
): string {
  const parameters = [
    `realm="eruoo-api"`,
    `resource_metadata="${appOrigin}/.well-known/oauth-protected-resource/api"`,
  ]
  if (error) parameters.push(`error="${error}"`)
  if (scopes?.length) parameters.push(`scope="${scopes.join(" ")}"`)
  return `Bearer ${parameters.join(", ")}`
}

function withBearerChallenge(response: Response, challenge: string): Response {
  response.headers.set("WWW-Authenticate", challenge)
  return response
}

function readBearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer +(.+)$/i.exec(header ?? "")
  return match?.[1]
}

export function createRequireOAuthPrincipal(
  requiredScopes: NonEmptyScopes,
): MiddlewareHandler<AppBindings> {
  if (requiredScopes.length === 0) {
    throw new TypeError("OAuth routes must require at least one scope.")
  }

  const uniqueRequiredScopes = [...new Set(requiredScopes)]
  if (
    uniqueRequiredScopes.length !== requiredScopes.length ||
    uniqueRequiredScopes.some(
      (scope) => scope !== "api:read" && scope !== "api:write",
    )
  ) {
    throw new TypeError("OAuth routes must use unique business API scopes.")
  }

  return async (context, next) => {
    const config = getRuntimeConfig(context.env)
    const challenge = bearerChallenge(config.appOrigin)
    const inspection = inspectCredentialCarriers(context.req.raw)
    const requestUrl = new URL(context.req.url)
    const bodyAccessToken = await hasUnsupportedBodyAccessToken(context.req.raw)
    const involvesBearer =
      context.req.header("authorization") !== undefined ||
      requestUrl.searchParams.has("access_token") ||
      bodyAccessToken

    if (inspection.invalid || bodyAccessToken) {
      const response = problem(context, {
        detail:
          "The request contains an invalid or ambiguous credential carrier.",
        slug: "invalid-request",
      })

      return involvesBearer
        ? withBearerChallenge(
            response,
            bearerChallenge(config.appOrigin, "invalid_request"),
          )
        : response
    }

    if (
      inspection.carriers.length !== 1 ||
      inspection.carriers[0] !== "bearer"
    ) {
      return withBearerChallenge(
        problem(context, {
          detail: "A valid OAuth access token is required.",
          slug: "authentication-required",
        }),
        challenge,
      )
    }

    const token = readBearerToken(context.req.header("authorization"))
    if (!token) {
      return withBearerChallenge(
        problem(context, {
          detail: "A valid OAuth access token is required.",
          slug: "invalid-credential",
        }),
        bearerChallenge(config.appOrigin, "invalid_token"),
      )
    }

    let principal: Principal

    try {
      const userInfoAudience = `${config.appOrigin}/api/auth/oauth2/userinfo`
      const verified = await verifyOAuthAccessToken(token, {
        additionalAudienceRequiredScopeByAudience: {
          [userInfoAudience]: "openid",
        },
        audience: OAUTH_RESOURCE,
        clockToleranceSeconds:
          OAUTH_ACCESS_TOKEN_PRODUCTION_CLOCK_TOLERANCE_SECONDS,
        issuer: config.appOrigin,
        keyResolver: createD1OAuthJwksResolver(context.env.DB),
        scopeAudienceByName: {
          "api:read": OAUTH_RESOURCE,
          "api:write": OAUTH_RESOURCE,
          offline_access: OAUTH_RESOURCE,
          openid: userInfoAudience,
          profile: userInfoAudience,
        },
      })

      if (!enabledClientIds.has(verified.principal.clientId ?? "")) {
        throw new Error("The OAuth client is not enabled.")
      }

      principal = verified.principal
    } catch (error) {
      if (error instanceof OAuthJwksDependencyError) {
        console.error({
          error: error.name,
          event: "oauth_jwks_dependency_failed",
          requestId: context.get("requestId"),
        })
        return problem(context, {
          detail: "The OAuth access token could not be verified.",
          slug: "service-unavailable",
        })
      }

      return withBearerChallenge(
        problem(context, {
          detail: "A valid OAuth access token is required.",
          slug: "invalid-credential",
        }),
        bearerChallenge(config.appOrigin, "invalid_token"),
      )
    }

    const grantedScopes = new Set(principal.scopes)
    if (uniqueRequiredScopes.some((scope) => !grantedScopes.has(scope))) {
      return withBearerChallenge(
        problem(context, {
          detail: "The OAuth access token lacks a required scope.",
          slug: "insufficient-scope",
        }),
        bearerChallenge(
          config.appOrigin,
          "insufficient_scope",
          uniqueRequiredScopes,
        ),
      )
    }

    context.set("principal", principal)
    await next()
  }
}

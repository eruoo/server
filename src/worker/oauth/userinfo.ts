import type { MiddlewareHandler } from "hono"

import { OAUTH_RESOURCE } from "../../shared/oauth"
import { inspectCredentialCarriers } from "../auth/carriers"
import type { AppBindings } from "../http/types"
import { verifyOAuthAccessToken } from "./access-token"
import {
  clientAllowsResources,
  clientAllowsScopes,
  OAuthClientPolicyError,
  readOAuthClientPolicy,
} from "./client-policy"
import { createD1OAuthJwksResolver, OAuthJwksDependencyError } from "./jwks"
export const verifyUserInfoCredential: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const fail = (status: number, error?: string) =>
    Response.json(error ? { error } : {}, {
      status,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": `Bearer realm="eruoo-api"${error ? `, error="${error}"` : ""}`,
      },
    })
  const inspection = inspectCredentialCarriers(c.req.raw)
  if (inspection.invalid) return fail(400, "invalid_request")
  if (!inspection.carriers.length) return fail(401)
  if (inspection.carriers[0] !== "bearer") return fail(400, "invalid_request")
  const audience = `${c.env.APP_ORIGIN}/api/auth/oauth2/userinfo`
  let verified
  try {
    verified = await verifyOAuthAccessToken(
      c.req.header("authorization")!.replace(/^Bearer +/i, ""),
      {
        issuer: c.env.APP_ORIGIN,
        audience: OAUTH_RESOURCE,
        additionalAudienceRequiredScopeByAudience: { [audience]: "openid" },
        scopeAudienceByName: {
          openid: audience,
          profile: audience,
          "api:read": OAUTH_RESOURCE,
          "api:write": OAUTH_RESOURCE,
          offline_access: OAUTH_RESOURCE,
        },
        clockToleranceSeconds: 60,
        keyResolver: createD1OAuthJwksResolver(c.env.DB),
      },
    )
  } catch (error) {
    return fail(
      error instanceof OAuthJwksDependencyError ? 503 : 401,
      error instanceof OAuthJwksDependencyError
        ? "temporarily_unavailable"
        : "invalid_token",
    )
  }
  if (!verified.principal.scopes.includes("openid"))
    return fail(403, "insufficient_scope")
  if (!verified.principal.clientId) return fail(401, "invalid_token")
  try {
    const client = await readOAuthClientPolicy(
      c.env.DB,
      verified.principal.clientId,
    )
    if (
      !clientAllowsScopes(client, verified.principal.scopes) ||
      !clientAllowsResources(client, [OAUTH_RESOURCE])
    )
      return fail(401, "invalid_token")
    const owner = await c.env.DB.prepare(
      "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1",
    )
      .bind(verified.principal.subject, c.env.OWNER_GITHUB_ID)
      .first()
    if (!owner) return fail(401, "invalid_token")
  } catch (error) {
    if (
      error instanceof OAuthClientPolicyError &&
      error.error === "invalid_client"
    )
      return fail(401, "invalid_token")
    return fail(503, "temporarily_unavailable")
  }
  await next()
}

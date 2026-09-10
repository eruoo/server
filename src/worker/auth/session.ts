import type { Context, MiddlewareHandler } from "hono"

import { scheduleAuditEvent } from "../audit"
import { createAuth } from "../auth"
import { problem } from "../http/response"
import type { AppBindings, OwnerSession } from "../http/types"
import {
  hasUnsupportedBodyAccessToken,
  inspectCredentialCarriers,
} from "./carriers"

export function getRequestAuth(c: Context<AppBindings>) {
  let auth = c.get("auth")
  if (!auth) {
    auth = createAuth(
      {
        appOrigin: c.env.APP_ORIGIN,
        betterAuthSecrets: c.env.BETTER_AUTH_SECRETS,
        githubClientId: c.env.GITHUB_CLIENT_ID,
        githubClientSecret: c.env.GITHUB_CLIENT_SECRET,
        ownerGitHubId: c.env.OWNER_GITHUB_ID,
        onSigningKeyCreated: (key) =>
          scheduleAuditEvent(c, {
            type: "jwt_signing_key_rotated",
            outcome: "success",
            credentialId: key.id,
            metadata: { algorithm: key.alg ?? "EdDSA" },
          }),
        onSessionCreated: (session) =>
          c.set("principal", {
            subject: session.userId,
            sessionId: session.id,
          }),
      },
      c.env.DB,
    )
    c.set("auth", auth)
  }
  return auth
}

export async function readOwnerSession(
  c: Context<AppBindings>,
  recent = false,
  persistent = recent,
): Promise<OwnerSession | ReturnType<typeof problem>> {
  const cached = c.get("principal")
  if (
    cached &&
    c.get("sessionRead") &&
    (!persistent || c.get("sessionRead") === "strong")
  )
    return cached
  const inspection = inspectCredentialCarriers(c.req.raw)
  if (inspection.invalid || (await hasUnsupportedBodyAccessToken(c.req.raw)))
    return problem("invalid-request", c.get("requestId"))
  if (inspection.carriers.length === 0)
    return problem("authentication-required", c.get("requestId"))
  if (inspection.carriers[0] !== "session")
    return problem("permission-denied", c.get("requestId"))
  try {
    const result = await getRequestAuth(c).api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: persistent },
      returnHeaders: true,
    })
    for (const cookie of result.headers.getSetCookie())
      c.get("responseCookies").push(cookie)
    if (!result.response)
      return problem("invalid-credential", c.get("requestId"))
    const { user, session } = result.response
    const owner = await c.env.DB.prepare(
      "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1",
    )
      .bind(user.id, c.env.OWNER_GITHUB_ID)
      .first()
    if (!owner) return problem("invalid-credential", c.get("requestId"))
    const raw = (
      session as typeof session & { reauthenticatedAt?: string | number | Date }
    ).reauthenticatedAt
    const reauthenticatedAt =
      raw === undefined ? undefined : new Date(raw).getTime()
    if (
      recent &&
      (reauthenticatedAt === undefined ||
        !Number.isFinite(reauthenticatedAt) ||
        Date.now() < reauthenticatedAt ||
        Date.now() - reauthenticatedAt > 900_000)
    )
      return problem("recent-authentication-required", c.get("requestId"))
    const principal = {
      subject: user.id,
      sessionId: session.id,
      reauthenticatedAt,
    }
    c.set("sessionRead", recent ? "strong" : "weak")
    c.set("principal", principal)
    return principal
  } catch {
    return problem("service-unavailable", c.get("requestId"))
  }
}
export const requireOwnerSession: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const result = await readOwnerSession(c)
  if (result instanceof Response) return result
  await next()
}
export const requireRecentOwnerSession: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const result = await readOwnerSession(c, true)
  if (result instanceof Response) return result
  await next()
}

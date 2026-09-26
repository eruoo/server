import type { Context, MiddlewareHandler } from "hono"

import { assertAuditSecret } from "../audit"
import { inspectCredentialCarriers } from "../auth/carriers"
import { limitAuthEntry } from "../auth/entry-limit"
import { handleRequestAuth, readOwnerSession } from "../auth/session"
import { withReadDeadline } from "../http/response"
import type { AppBindings } from "../http/types"
import { enforceOAuthRefreshFamilyRevocation } from "./families"
import {
  validateOAuthAuthorizationRequest,
  validateOAuthEndSessionRequest,
  validateOAuthTokenRequest,
  validateOAuthRevocationRequest,
  validateOAuthUserInfoRequest,
  oauthTokenServiceUnavailable,
} from "./protocol"
import { verifyUserInfoCredential } from "./userinfo"

export const oauthOperations = new Map<
  string,
  | "authorize"
  | "token"
  | "revoke"
  | "userinfo"
  | "jwks"
  | "browser"
  | "logout"
  | "introspect"
>([
  ["GET /api/auth/oauth2/authorize", "authorize"],
  ["POST /api/auth/oauth2/authorize", "authorize"],
  ["POST /api/auth/oauth2/token", "token"],
  ["POST /api/auth/oauth2/revoke", "revoke"],
  ["POST /api/auth/oauth2/introspect", "introspect"],
  ["POST /api/auth/oauth2/end-session/confirm", "logout"],
  ["GET /api/auth/oauth2/userinfo", "userinfo"],
  ["POST /api/auth/oauth2/userinfo", "userinfo"],
  ["GET /api/auth/jwks", "jwks"],
  ["POST /api/auth/oauth2/consent", "browser"],
  ["POST /api/auth/oauth2/continue", "browser"],
  ["GET /api/auth/oauth2/end-session", "logout"],
  ["POST /api/auth/oauth2/end-session", "logout"],
])
export async function handleOAuthRequest(
  c: Context<AppBindings>,
): Promise<Response> {
  const operation = oauthOperations.get(
    `${c.req.method} ${new URL(c.req.url).pathname}`,
  )
  const fail = (error = "invalid_request", status = 400) =>
    Response.json(
      { error },
      { status, headers: { "cache-control": "no-store" } },
    )
  if (!operation) return fail("invalid_request", 404)
  if (["authorize", "browser", "logout"].includes(operation)) {
    const inspection = inspectCredentialCarriers(c.req.raw)
    if (
      inspection.invalid ||
      inspection.carriers.some((carrier) => carrier !== "session")
    )
      return fail()
  }
  if (!["userinfo", "jwks"].includes(operation))
    assertAuditSecret(c.env.AUDIT_IP_HASH_SECRET)
  if (c.req.method === "POST") {
    if (c.req.header("origin") && c.req.header("origin") !== c.env.APP_ORIGIN)
      return fail()
    if (operation === "browser" && c.req.header("origin") !== c.env.APP_ORIGIN)
      return fail()
    const type = c.req
      .header("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase()
    if (
      type !==
      (operation === "browser"
        ? "application/json"
        : "application/x-www-form-urlencoded")
    )
      return fail()
  }
  if (!["userinfo", "jwks"].includes(operation)) {
    const limited = await limitAuthEntry(
      c,
      `${c.req.method} ${new URL(c.req.url).pathname}`,
    )
    if (limited) {
      const response = fail(
        limited.status === 429 ? "slow_down" : "temporarily_unavailable",
        limited.status,
      )
      if (limited.status === 429) response.headers.set("retry-after", "60")
      return response
    }
  }
  const validators: MiddlewareHandler<AppBindings>[] = []
  if (operation === "authorize")
    validators.push(validateOAuthAuthorizationRequest)
  if (operation === "logout") validators.push(validateOAuthEndSessionRequest)
  if (operation === "token")
    validators.push(
      validateOAuthTokenRequest,
      enforceOAuthRefreshFamilyRevocation,
    )
  if (operation === "revoke")
    validators.push(
      validateOAuthRevocationRequest,
      enforceOAuthRefreshFamilyRevocation,
    )
  if (operation === "introspect")
    validators.push(validateOAuthRevocationRequest)
  if (operation === "userinfo")
    validators.push(validateOAuthUserInfoRequest, verifyUserInfoCredential)
  const execute = async () => {
    try {
      const terminal: MiddlewareHandler<AppBindings> = async (context) => {
        if (
          ["authorize", "browser"].includes(operation) &&
          inspectCredentialCarriers(context.req.raw).carriers.includes(
            "session",
          )
        ) {
          const owner = await readOwnerSession(context, false, true)
          if (owner instanceof Response) {
            if (owner.status !== 401 || operation === "browser") {
              context.res = fail(
                owner.status >= 500
                  ? "temporarily_unavailable"
                  : "access_denied",
                owner.status,
              )
              return
            }
            const headers = new Headers(context.req.raw.headers)
            headers.delete("cookie")
            context.req.raw = new Request(context.req.raw, { headers })
          }
        }
        const response = await handleRequestAuth(context, context.req.raw)
        context.res = response
      }
      const chain = [...validators, terminal]
      async function dispatch(index: number): Promise<void> {
        const middleware = chain[index]
        if (!middleware) return
        const response = await middleware(c, () => dispatch(index + 1))
        if (response instanceof Response) c.res = response
      }
      await dispatch(0)
      c.res.headers.set(
        "cache-control",
        operation === "jwks" && c.res.ok ? "public, max-age=300" : "no-store",
      )
      return c.res
    } catch {
      return operation === "token"
        ? oauthTokenServiceUnavailable(c)
        : fail("temporarily_unavailable", 503)
    }
  }
  return ["userinfo", "jwks"].includes(operation)
    ? withReadDeadline(execute(), c.get("requestId"))
    : execute()
}

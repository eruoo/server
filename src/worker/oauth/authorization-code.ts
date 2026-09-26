import { APIError } from "better-auth/api"
import { z } from "zod"

import {
  clientAllowsResources,
  clientAllowsScopes,
  matchesRegisteredRedirect,
  OAuthClientPolicyError,
  readOAuthClientPolicy,
} from "./client-policy"

const authorizationCodeSchema = z.object({
  type: z.literal("authorization_code"),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  resource: z.array(z.string()).min(1),
  query: z.object({
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    response_type: z.literal("code"),
    scope: z.string().min(1),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
  }),
})

export interface OAuthGrantCreated {
  clientId: string
  subjectId: string
}

export interface OAuthGrantFailure {
  error: string
  status: number
}

function readAuthorizationCode(value: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("type" in parsed) ||
    parsed.type !== "authorization_code"
  )
    return undefined
  const result = authorizationCodeSchema.safeParse(parsed)
  if (!result.success)
    throw new APIError("BAD_REQUEST", { error: "invalid_request" })
  return result.data
}

/** All provider issuance paths, including its internal post-login dispatch, write here. */
export function authorizationCodeHooks(
  database: D1Database,
  ownerGitHubId: string,
  onCreated?: (grant: OAuthGrantCreated) => void,
  onRejected?: (failure: OAuthGrantFailure) => void,
) {
  return {
    before: async (verification: { value: string }) => {
      try {
        const code = readAuthorizationCode(verification.value)
        if (!code) return
        const client = await readOAuthClientPolicy(
          database,
          code.query.client_id,
        )
        if (
          !client.grantTypes.includes("authorization_code") ||
          !matchesRegisteredRedirect(
            code.query.redirect_uri,
            client.redirectUris,
            client.applicationType,
          ) ||
          !clientAllowsScopes(client, code.query.scope.split(" ")) ||
          !clientAllowsResources(client, code.resource)
        )
          throw new APIError("BAD_REQUEST", { error: "invalid_request" })
        // Recheck persistent session and owner after a signed login continuation.
        const session = await database
          .prepare(
            "SELECT session.expiresAt FROM session JOIN account ON account.userId=session.userId WHERE session.id=? AND session.userId=? AND account.providerId='github' AND account.accountId=? LIMIT 1",
          )
          .bind(code.sessionId, code.userId, ownerGitHubId)
          .first<{ expiresAt: string | number }>()
        if (!session || !(new Date(session.expiresAt).getTime() > Date.now()))
          throw new APIError("FORBIDDEN", { error: "access_denied" })
      } catch (error) {
        const failure =
          error instanceof APIError
            ? error
            : error instanceof OAuthClientPolicyError &&
                error.error === "invalid_client"
              ? new APIError("BAD_REQUEST", { error: "invalid_client" })
              : new APIError("SERVICE_UNAVAILABLE", {
                  error: "temporarily_unavailable",
                })
        onRejected?.({
          error: String(failure.body?.["error"] ?? "temporarily_unavailable"),
          status: failure.statusCode,
        })
        throw failure
      }
    },
    after: async (verification: { value: string }) => {
      const code = readAuthorizationCode(verification.value)
      if (code)
        onCreated?.({ clientId: code.query.client_id, subjectId: code.userId })
    },
  }
}

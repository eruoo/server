import { createHash } from "node:crypto"

import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"

import { OAUTH_RESOURCE } from "../../../src/shared/oauth"
import worker from "../../../src/worker"
let requestCounter = 0
export const origin = "http://localhost:5173"
export async function oauthFetch(
  path: string,
  init?: RequestInit,
  database = env.DB,
) {
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(origin + path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        "cf-connecting-ip": `2001:db8::${(++requestCounter).toString(16)}`,
      },
    }),
    { ...env, APP_ORIGIN: origin, DB: database },
    context,
  )
  await waitOnExecutionContext(context)
  return response
}
export const storedTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("base64url")
export function refresh(token: string, database = env.DB) {
  return oauthFetch(
    "/api/auth/oauth2/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "eruoo-desktop",
        refresh_token: token,
      }),
    },
    database,
  )
}
export async function issueGrant(cookie: string) {
  const verifier = crypto.randomUUID().repeat(2)
  const redirect = "http://127.0.0.1:49152/oauth/callback"
  const query = new URLSearchParams({
    client_id: "eruoo-desktop",
    redirect_uri: redirect,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: storedTokenHash(verifier),
    scope: "openid profile api:read api:write offline_access",
    resource: OAUTH_RESOURCE,
    state: crypto.randomUUID(),
    nonce: crypto.randomUUID(),
  })
  const authorization = await oauthFetch(
    `/api/auth/oauth2/authorize?${query}`,
    { headers: { cookie } },
  )
  const code = new URL(authorization.headers.get("location")!).searchParams.get(
    "code",
  )
  if (!code) throw new Error("Code was not issued")
  const response = await oauthFetch("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "eruoo-desktop",
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
      resource: OAUTH_RESOURCE,
    }),
  })
  if (!response.ok) throw new Error("Token exchange failed")
  return response.json<{ access_token: string; refresh_token: string }>()
}

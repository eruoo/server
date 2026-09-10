import { getAuthTables } from "better-auth/db"
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import worker from "../../src/worker"
import { createAuthOptions } from "../../src/worker/auth"
import { ownerSession } from "./fixtures/session"
const applicationOrigin = "http://localhost:5173"
async function fetchWorker(path: string, init?: RequestInit) {
  const ctx = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${applicationOrigin}${path}`, init),
    { ...env, APP_ORIGIN: applicationOrigin },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}
async function token(values: Record<string, string>) {
  return fetchWorker("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  })
}
describe("OAuth server", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM rateLimit"),
    ])
  })
  it("has every installed authentication schema field in the empty baseline", async () => {
    const tables = getAuthTables(
      createAuthOptions(
        {
          appOrigin: env.APP_ORIGIN,
          betterAuthSecrets: env.BETTER_AUTH_SECRETS,
          githubClientId: env.GITHUB_CLIENT_ID,
          githubClientSecret: env.GITHUB_CLIENT_SECRET,
          ownerGitHubId: env.OWNER_GITHUB_ID,
        },
        env.DB,
      ),
    )
    const missing: string[] = []
    for (const table of Object.values(tables)) {
      const rows = await env.DB.prepare(
        `PRAGMA table_info("${table.modelName}")`,
      ).all<{ name: string }>()
      const fields = new Set(rows.results.map((row) => row.name))
      for (const [name, field] of Object.entries(table.fields))
        if (!fields.has(field.fieldName ?? name))
          missing.push(`${table.modelName}.${field.fieldName ?? name}`)
    }
    expect(missing).toEqual([])
  })
  it("ordinary logout ignores an unrelated expired OAuth continuation", async () => {
    const session = await ownerSession()
    const response = await fetchWorker("/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: applicationOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        oauth_query: "sig=invalid&client_id=eruoo-desktop",
      }),
    })
    expect(response.status).toBe(200)
  })
  it("issues a code with PKCE, rotates refresh tokens, and revokes the family", async () => {
    const session = await ownerSession()
    const verifier = "a".repeat(64)
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    )
    const challenge = btoa(String.fromCharCode(...hash))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
    const redirect = "http://127.0.0.1:49152/oauth/callback"
    const query = new URLSearchParams({
      client_id: "eruoo-desktop",
      redirect_uri: redirect,
      response_type: "code",
      scope: "openid profile api:read api:write offline_access",
      resource: OAUTH_RESOURCE,
      state: "state-test",
      nonce: "nonce-test",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    const authorization = await fetchWorker(
      `/api/auth/oauth2/authorize?${query}`,
      { headers: { cookie: session.cookie } },
    )
    expect(authorization.status).toBe(302)
    const location = new URL(authorization.headers.get("location")!)
    expect(location.searchParams.get("error")).toBeNull()
    const code = location.searchParams.get("code")!
    expect(code).toBeTruthy()
    const exchange = await token({
      grant_type: "authorization_code",
      client_id: "eruoo-desktop",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: OAUTH_RESOURCE,
    })
    const body = await exchange.json<{
      error?: string
      access_token: string
      refresh_token: string
    }>()
    expect(exchange.status).toBe(200)
    expect(body.refresh_token).toBeTruthy()
    const userinfo = await fetchWorker("/api/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    })
    expect(userinfo.status).toBe(200)
    expect((await userinfo.json<{ sub: string }>()).sub).toBe(session.id)

    const wrongHint = await fetchWorker("/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "eruoo-desktop",
        token: body.access_token,
        token_type_hint: "refresh_token",
      }),
    })
    expect((await wrongHint.json<{ error: string }>()).error).toBe(
      "unsupported_token_type",
    )

    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: "eruoo-desktop",
      refresh_token: body.refresh_token,
    })
    expect(refreshed.status).toBe(200)
    const rotated = await refreshed.json<{
      refresh_token: string
      access_token: string
    }>()
    expect(rotated.refresh_token).not.toBe(body.refresh_token)
    const replay = await token({
      grant_type: "refresh_token",
      client_id: "eruoo-desktop",
      refresh_token: body.refresh_token,
    })
    expect((await replay.json<{ refresh_token: string }>()).refresh_token).toBe(
      rotated.refresh_token,
    )
    const revoked = await fetchWorker("/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "eruoo-desktop",
        token: body.refresh_token,
        token_type_hint: "access_token",
      }),
    })
    expect(revoked.status).toBe(200)
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: "eruoo-desktop",
          refresh_token: rotated.refresh_token,
        })
      ).status,
    ).toBe(400)
  })
})

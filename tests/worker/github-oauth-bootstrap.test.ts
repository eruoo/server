import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import { OWNER_GITHUB_ID } from "../../src/shared/security"

const applicationOrigin = "http://localhost:5173"
const syntheticAccessToken = "synthetic-github-access-token"

interface SyntheticGitHubProfile {
  email: string
  id: number
  login: string
  name: string
}

interface StartedOAuthFlow {
  state: string
  stateCookie: string
}

function installSyntheticGitHub(profile: SyntheticGitHubProfile) {
  const requests: string[] = []
  const syntheticFetch: typeof fetch = async (input, init) => {
    const request =
      input instanceof Request && init === undefined
        ? input.clone()
        : new Request(input, init)
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.origin}${url.pathname}`)

    if (
      request.method === "POST" &&
      url.origin === "https://github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      return Response.json({
        access_token: syntheticAccessToken,
        scope: "read:user,user:email",
        token_type: "bearer",
      })
    }

    if (
      request.method === "GET" &&
      url.origin === "https://api.github.com" &&
      url.pathname === "/user"
    ) {
      if (
        request.headers.get("authorization") !==
        `Bearer ${syntheticAccessToken}`
      ) {
        throw new Error(
          "GitHub profile request did not use the exchanged token.",
        )
      }
      return Response.json({
        avatar_url: "https://avatars.example.invalid/synthetic.png",
        ...profile,
      })
    }

    if (
      request.method === "GET" &&
      url.origin === "https://api.github.com" &&
      url.pathname === "/user/emails"
    ) {
      if (
        request.headers.get("authorization") !==
        `Bearer ${syntheticAccessToken}`
      ) {
        throw new Error("GitHub email request did not use the exchanged token.")
      }
      return Response.json([
        {
          email: profile.email,
          primary: true,
          verified: true,
          visibility: "private",
        },
      ])
    }

    throw new Error(`Unexpected outbound request: ${request.method} ${url}`)
  }

  return {
    fetchSpy: vi.spyOn(globalThis, "fetch").mockImplementation(syntheticFetch),
    requests,
  }
}

async function startGitHubOAuthFlow(
  oauthQuery?: string,
): Promise<StartedOAuthFlow> {
  const response = await SELF.fetch(
    "http://local.test/api/auth/sign-in/social",
    {
      body: JSON.stringify({
        callbackURL: "/",
        disableRedirect: true,
        errorCallbackURL: oauthQuery ? `/login?${oauthQuery}` : "/login",
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        provider: "github",
      }),
      headers: {
        "cf-connecting-ip": "192.0.2.1",
        "content-type": "application/json",
        origin: applicationOrigin,
      },
      method: "POST",
    },
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    redirect?: boolean
    url?: string
  }
  expect(body.redirect).toBe(false)

  const authorizationUrl = new URL(body.url ?? "")
  expect(authorizationUrl.origin).toBe("https://github.com")
  expect(authorizationUrl.pathname).toBe("/login/oauth/authorize")
  expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
    "S256",
  )
  const state = authorizationUrl.searchParams.get("state")
  expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/)

  const stateCookie = response.headers
    .get("set-cookie")
    ?.match(/(?:__Secure-)?eruoo\.state=[^;,\s]+/)?.[0]
  expect(stateCookie).toBeTruthy()

  const storedState = await env.DB.prepare(
    `SELECT identifier, expiresAt, typeof(expiresAt) AS expiresAtStorageType
     FROM verification
     WHERE identifier = ?1`,
  )
    .bind(state)
    .first<{
      expiresAt: string
      expiresAtStorageType: string
      identifier: string
    }>()
  expect(storedState?.identifier).toBe(state)
  expect(storedState?.expiresAtStorageType).toBe("text")
  expect(new Date(storedState?.expiresAt ?? 0).getTime()).toBeGreaterThan(
    Date.now(),
  )

  return {
    state: state!,
    stateCookie: stateCookie!,
  }
}

async function startOwnerAuthorizationBeforeLogin(): Promise<string> {
  const authorizeUrl = new URL("http://local.test/api/auth/oauth2/authorize")
  authorizeUrl.searchParams.set("client_id", "eruoo-desktop")
  authorizeUrl.searchParams.set("code_challenge", "A".repeat(43))
  authorizeUrl.searchParams.set("code_challenge_method", "S256")
  authorizeUrl.searchParams.set("nonce", "continued-nonce")
  authorizeUrl.searchParams.set(
    "redirect_uri",
    "http://127.0.0.1:49152/oauth/callback",
  )
  authorizeUrl.searchParams.set("resource", OAUTH_RESOURCE)
  authorizeUrl.searchParams.set("response_type", "code")
  authorizeUrl.searchParams.set(
    "scope",
    "openid profile api:read api:write offline_access",
  )
  authorizeUrl.searchParams.set("state", "continued-state")

  const response = await SELF.fetch(authorizeUrl, {
    headers: { "cf-connecting-ip": "192.0.2.1" },
    redirect: "manual",
  })
  expect(response.status).toBe(302)
  const loginUrl = new URL(
    response.headers.get("location") ?? "",
    applicationOrigin,
  )
  expect(loginUrl.origin).toBe(applicationOrigin)
  expect(loginUrl.pathname).toBe("/login")
  expect(loginUrl.searchParams.get("sig")).toMatch(/\S+/)
  expect(loginUrl.searchParams.getAll("ba_param")).toContain("client_id")
  return loginUrl.searchParams.toString()
}

async function completeGitHubOAuthFlow(
  flow: StartedOAuthFlow,
): Promise<Response> {
  return SELF.fetch(
    `http://local.test/api/auth/callback/github?code=synthetic-code&state=${encodeURIComponent(flow.state)}`,
    {
      headers: {
        accept: "text/html",
        "cf-connecting-ip": "192.0.2.1",
        cookie: flow.stateCookie,
        "sec-fetch-mode": "navigate",
      },
      redirect: "manual",
    },
  )
}

async function countRows(table: "account" | "session" | "user") {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>()
  return result?.count ?? 0
}

async function latestGitHubLoginAudit() {
  return env.DB.prepare(
    `SELECT outcome, subjectId, type
     FROM security_audit_events
     WHERE type = 'github_login'
     ORDER BY occurredAt DESC
     LIMIT 1`,
  ).first<{
    outcome: string
    subjectId: string | null
    type: string
  }>()
}

describe("GitHub OAuth owner bootstrap", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM security_audit_events"),
      env.DB.prepare("DELETE FROM verification"),
      env.DB.prepare("DELETE FROM passkey"),
      env.DB.prepare("DELETE FROM apikey"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
      env.DB.prepare("DELETE FROM rateLimit"),
    ])
  })

  it("creates the owner only after the real callback receives the approved raw GitHub ID", async () => {
    const github = installSyntheticGitHub({
      email: "owner@example.invalid",
      id: Number(OWNER_GITHUB_ID),
      login: "synthetic-owner",
      name: "Synthetic Owner",
    })

    try {
      const flow = await startGitHubOAuthFlow()
      const response = await completeGitHubOAuthFlow(flow)

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/")
      expect(response.headers.get("set-cookie")).toMatch(
        /(?:__Secure-)?eruoo\.session_token=/,
      )
      expect(github.requests).toEqual([
        "POST https://github.com/login/oauth/access_token",
        "GET https://api.github.com/user",
        "GET https://api.github.com/user/emails",
      ])

      const account = await env.DB.prepare(
        `SELECT accountId, providerId, userId
         FROM account
         LIMIT 1`,
      ).first<{
        accountId: string
        providerId: string
        userId: string
      }>()
      const session = await env.DB.prepare(
        "SELECT userId FROM session LIMIT 1",
      ).first<{ userId: string }>()

      expect(await countRows("user")).toBe(1)
      expect(await countRows("account")).toBe(1)
      expect(await countRows("session")).toBe(1)
      expect(account).toMatchObject({
        accountId: OWNER_GITHUB_ID,
        providerId: "github",
      })
      expect(session?.userId).toBe(account?.userId)
      await expect(latestGitHubLoginAudit()).resolves.toEqual({
        outcome: "success",
        subjectId: null,
        type: "github_login",
      })
    } finally {
      github.fetchSpy.mockRestore()
    }
  })

  it("continues the complete authorization request after GitHub login", async () => {
    const github = installSyntheticGitHub({
      email: "owner@example.invalid",
      id: Number(OWNER_GITHUB_ID),
      login: "synthetic-owner",
      name: "Synthetic Owner",
    })

    try {
      const oauthQuery = await startOwnerAuthorizationBeforeLogin()
      const flow = await startGitHubOAuthFlow(oauthQuery)
      const storedOAuthState = await env.DB.prepare(
        "SELECT value FROM verification WHERE identifier = ?1",
      )
        .bind(flow.state)
        .first<{ value: string }>()
      expect(JSON.parse(storedOAuthState?.value ?? "null")).toMatchObject({
        serverContext: {
          query: expect.stringContaining("client_id=eruoo-desktop"),
        },
      })
      const response = await completeGitHubOAuthFlow(flow)
      const authorizationCodeCount = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM verification
         WHERE value LIKE '%"type":"authorization_code"%'`,
      ).first<{ count: number }>()
      expect(authorizationCodeCount?.count).toBe(1)
      expect(response.status).toBe(302)
      const location = response.headers.get("location")
      expect(location).toBeTruthy()
      const callback = new URL(location!, applicationOrigin)
      expect(callback.origin + callback.pathname).toBe(
        "http://127.0.0.1:49152/oauth/callback",
      )
      expect(callback.searchParams.get("code")).toMatch(/\S+/)
      expect(callback.searchParams.get("iss")).toBe(applicationOrigin)
      expect(callback.searchParams.get("state")).toBe("continued-state")
      expect(response.headers.get("set-cookie")).toMatch(
        /(?:__Secure-)?eruoo\.session_token=/,
      )
    } finally {
      github.fetchSpy.mockRestore()
    }
  })

  it("rejects a non-owner raw GitHub ID before creating any identity state", async () => {
    const github = installSyntheticGitHub({
      email: "intruder@example.invalid",
      id: 123456789,
      login: "synthetic-intruder",
      name: "Synthetic Intruder",
    })

    try {
      const flow = await startGitHubOAuthFlow()
      const response = await completeGitHubOAuthFlow(flow)
      const location = new URL(
        response.headers.get("location") ?? "",
        applicationOrigin,
      )

      expect(response.status).toBe(302)
      expect(location.origin).toBe(applicationOrigin)
      expect(location.pathname).toBe("/login")
      expect(location.searchParams.get("error")).toBe("owner_not_allowed")
      expect(response.headers.get("set-cookie")).not.toMatch(
        /(?:__Secure-)?eruoo\.session_token=/,
      )
      expect(github.requests).toEqual([
        "POST https://github.com/login/oauth/access_token",
        "GET https://api.github.com/user",
        "GET https://api.github.com/user/emails",
      ])
      expect(await countRows("user")).toBe(0)
      expect(await countRows("account")).toBe(0)
      expect(await countRows("session")).toBe(0)
      await expect(latestGitHubLoginAudit()).resolves.toEqual({
        outcome: "failure",
        subjectId: null,
        type: "github_login",
      })
    } finally {
      github.fetchSpy.mockRestore()
    }
  })

  it("returns a failed GitHub continuation to the signed login request", async () => {
    const github = installSyntheticGitHub({
      email: "intruder@example.invalid",
      id: 123456789,
      login: "synthetic-intruder",
      name: "Synthetic Intruder",
    })

    try {
      const oauthQuery = await startOwnerAuthorizationBeforeLogin()
      const flow = await startGitHubOAuthFlow(oauthQuery)
      const response = await completeGitHubOAuthFlow(flow)
      const location = new URL(
        response.headers.get("location") ?? "",
        applicationOrigin,
      )
      const expectedSignedParams = new URLSearchParams(oauthQuery)

      expect(response.status).toBe(302)
      expect(location.origin).toBe(applicationOrigin)
      expect(location.pathname).toBe("/login")
      expect(location.searchParams.get("error")).toBe("owner_not_allowed")
      for (const parameterName of new Set(expectedSignedParams.keys())) {
        expect(location.searchParams.getAll(parameterName)).toEqual(
          expectedSignedParams.getAll(parameterName),
        )
      }
      expect(await countRows("user")).toBe(0)
      expect(await countRows("account")).toBe(0)
      expect(await countRows("session")).toBe(0)
    } finally {
      github.fetchSpy.mockRestore()
    }
  })
})

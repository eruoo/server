import type { PasskeyOptions } from "@better-auth/passkey"
import type { BetterAuthOptions } from "better-auth"
import { betterAuth } from "better-auth"
import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { OWNER_GITHUB_ID } from "../../src/shared/security"
import { createApp } from "../../src/worker/app"
import {
  createAuth,
  createAuthOptions,
  type WorkerAuthEnv,
} from "../../src/worker/auth"
import { authDateToEpochMilliseconds } from "../../src/worker/auth/session"
import type { AuthEnv } from "../../src/worker/config"
import { createOwnerSession } from "./fixtures/owner-session"

const ownerGitHubId = OWNER_GITHUB_ID
const thirtyDaysInSeconds = 30 * 24 * 60 * 60

function productionAuthEnv(): AuthEnv {
  return {
    ALLOWED_CORS_ORIGINS: "[]",
    APP_ENV: "production",
    APP_ORIGIN: "https://auth.eruoo.me",
    BETTER_AUTH_SECRETS:
      "1:synthetic-better-auth-secret-used-only-in-worker-tests",
    GITHUB_CLIENT_ID: "synthetic-github-client-id",
    GITHUB_CLIENT_SECRET: "synthetic-github-client-secret",
    OWNER_GITHUB_ID: ownerGitHubId,
  }
}

function workerEnvWithSecrets(secrets: string): WorkerAuthEnv {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BETTER_AUTH_SECRETS") {
        return secrets
      }

      return Reflect.get(target, property, receiver)
    },
  })
}

function requireValidateUserInfo(
  options: BetterAuthOptions,
): NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]> {
  const validateUserInfo = options.user?.validateUserInfo

  if (!validateUserInfo) {
    throw new Error("The owner admission hook is not configured.")
  }

  return validateUserInfo
}

function requirePasskeyOptions(options: BetterAuthOptions): PasskeyOptions {
  const plugin = options.plugins?.find(({ id }) => id === "passkey")

  if (!plugin?.options) {
    throw new Error("The Passkey plugin is not configured.")
  }

  return plugin.options as PasskeyOptions
}

function requireOAuthProviderOptions(options: BetterAuthOptions): {
  resourceSeedMode?: "insertOnly" | "merge" | "overwrite"
} {
  const plugin = options.plugins?.find(({ id }) => id === "oauth-provider")

  if (!plugin?.options) {
    throw new Error("The OAuth Provider plugin is not configured.")
  }

  return plugin.options
}

function captureError(operation: () => unknown): Error {
  try {
    operation()
  } catch (error) {
    if (error instanceof Error) {
      return error
    }

    throw new Error("The operation threw a non-Error value.")
  }

  throw new Error("The operation did not throw.")
}

async function insertOwnerUser(): Promise<string> {
  const now = new Date().toISOString()
  const userId = crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, emailVerified, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(userId, "Synthetic Owner", `${userId}@example.invalid`, 1, now, now),
    env.DB.prepare(
      `INSERT INTO account (
         id, issuer, accountId, providerId, userId, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      "https://github.com",
      ownerGitHubId,
      "github",
      userId,
      now,
      now,
    ),
  ])

  return userId
}

async function updateOnlySessionReauthentication(
  reauthenticatedAt: Date,
): Promise<void> {
  await env.DB.prepare("UPDATE session SET reauthenticatedAt = ?1")
    .bind(reauthenticatedAt.toISOString())
    .run()
}

async function requestPasskeyRegistrationOptions(
  cookieValue: string,
): Promise<Response> {
  return SELF.fetch(
    "http://local.test/api/auth/passkey/generate-register-options",
    {
      headers: {
        cookie: cookieValue,
        origin: "http://localhost:5173",
      },
    },
  )
}

describe("Better Auth owner and session invariants", () => {
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

  it.each([
    [new Date("2026-08-23T01:02:03.456Z"), 1_787_446_923_456],
    ["2026-08-23T01:02:03.456Z", 1_787_446_923_456],
    [1_787_446_923_456, 1_787_446_923_456],
  ])(
    "normalizes Better Auth adapter date value %p to epoch milliseconds",
    (value, expected) => {
      expect(authDateToEpochMilliseconds(value)).toBe(expected)
    },
  )

  it.each([
    undefined,
    null,
    "not-a-date",
    Number.NaN,
    new Date("not-a-date"),
    {},
  ])("rejects invalid Better Auth adapter date value %p", (value) => {
    expect(authDateToEpochMilliseconds(value)).toBeUndefined()
  })

  it.each(["create-user", "link-account", "sign-in"] as const)(
    "allows the immutable owner identity at the %s admission boundary",
    async (action) => {
      const options = createAuthOptions(productionAuthEnv(), env.DB)
      const validateUserInfo = requireValidateUserInfo(options)

      const result = await validateUserInfo(
        {
          source: {
            action,
            method: "oauth",
            oauth: {
              profile: { id: Number(ownerGitHubId) },
              providerId: "github",
            },
          },
          user: {},
        },
        undefined as never,
      )

      expect(result).toBeUndefined()
    },
  )

  it.each([
    {
      method: "oauth",
      oauth: { profile: { id: "123" }, providerId: "github" },
    },
    {
      method: "oauth",
      oauth: { profile: { id: ownerGitHubId }, providerId: "google" },
    },
    { method: "email-password" },
  ] as const)(
    "rejects a non-owner source at the real Better Auth admission hook",
    async (source) => {
      const options = createAuthOptions(productionAuthEnv(), env.DB)
      const validateUserInfo = requireValidateUserInfo(options)

      const result = await validateUserInfo(
        {
          source: { action: "create-user", ...source },
          user: {},
        },
        undefined as never,
      )

      expect(result).toEqual({
        error: "owner_not_allowed",
        errorDescription: "This account is not allowed to sign in.",
      })
    },
  )

  it("configures an actual host-only secure Session cookie for 30 days", async () => {
    const auth = betterAuth(createAuthOptions(productionAuthEnv(), env.DB))
    const context = await auth.$context

    expect(context.sessionConfig.expiresIn).toBe(thirtyDaysInSeconds)
    expect(context.options.session).toMatchObject({
      cookieCache: { enabled: true, maxAge: 30, strategy: "jwe" },
      disableSessionRefresh: true,
      expiresIn: thirtyDaysInSeconds,
      freshAge: 0,
    })
    expect(context.authCookies.sessionToken).toEqual({
      attributes: expect.objectContaining({
        httpOnly: true,
        maxAge: thirtyDaysInSeconds,
        path: "/",
        sameSite: "lax",
        secure: true,
      }),
      name: "__Secure-eruoo.session_token",
    })
    expect(context.authCookies.sessionToken.attributes).not.toHaveProperty(
      "domain",
    )
  })

  it("configures Session reads without D1 rate limiting and enables native joins", () => {
    const options = createAuthOptions(productionAuthEnv(), env.DB)

    expect(options.rateLimit).toMatchObject({
      customRules: { "/get-session": false },
      enabled: true,
      storage: "database",
    })
    expect(options.advanced.database).toEqual({ joins: true })
  })

  it("uses insert-only OAuth resource seeding", () => {
    const options = createAuthOptions(productionAuthEnv(), env.DB)

    expect(requireOAuthProviderOptions(options).resourceSeedMode).toBe(
      "insertOnly",
    )
  })

  it("allows the isolated RS256 conformance fixture to overwrite its resource", () => {
    const options = createAuthOptions(productionAuthEnv(), env.DB, {
      oauthAccessTokenSigningAlgorithm: "RS256",
    })

    expect(requireOAuthProviderOptions(options).resourceSeedMode).toBe(
      "overwrite",
    )
  })

  it("does not persist Better Auth rate-limit state for Session reads", async () => {
    const cookie = await createOwnerSession()
    const anonymousResponse = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      },
    )
    const authenticatedResponse = await SELF.fetch(
      "http://local.test/api/auth/get-session",
      {
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          cookie: `eruoo.session_token=${cookie}`,
        },
      },
    )
    const rateLimitRows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM rateLimit",
    ).first<{ count: number }>()

    expect(anonymousResponse.status).toBe(200)
    await expect(anonymousResponse.json()).resolves.toBeNull()
    expect(authenticatedResponse.status).toBe(200)
    await expect(authenticatedResponse.json()).resolves.toMatchObject({
      session: expect.objectContaining({ userId: expect.any(String) }),
      user: expect.objectContaining({ id: expect.any(String) }),
    })
    expect(rateLimitRows?.count).toBe(0)
  })

  it("persists a newly created Session with a fixed 30-day expiry", async () => {
    const userId = await insertOwnerUser()
    const startedAt = Date.now()
    const context = await createAuth(env).$context
    const session = await context.internalAdapter.createSession(userId)
    const finishedAt = Date.now()

    expect(session).not.toBeNull()

    const row = await env.DB.prepare(
      `SELECT expiresAt, reauthenticatedAt
       FROM session
       WHERE userId = ?1`,
    )
      .bind(userId)
      .first<{ expiresAt: string; reauthenticatedAt: string }>()

    expect(row).not.toBeNull()
    expect(new Date(row?.expiresAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      startedAt + thirtyDaysInSeconds * 1000,
    )
    expect(new Date(row?.expiresAt ?? 0).getTime()).toBeLessThanOrEqual(
      finishedAt + thirtyDaysInSeconds * 1000,
    )
    expect(
      new Date(row?.reauthenticatedAt ?? 0).getTime(),
    ).toBeGreaterThanOrEqual(startedAt)
    expect(new Date(row?.reauthenticatedAt ?? 0).getTime()).toBeLessThanOrEqual(
      finishedAt,
    )
  })

  it("does not refresh or rewrite a persisted Session during status validation", async () => {
    const cookie = await createOwnerSession()
    const before = await env.DB.prepare(
      "SELECT expiresAt, updatedAt FROM session LIMIT 1",
    ).first<{ expiresAt: string; updatedAt: string }>()

    const response = await SELF.fetch("http://local.test/api/status", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })
    const after = await env.DB.prepare(
      "SELECT expiresAt, updatedAt FROM session LIMIT 1",
    ).first<{ expiresAt: string; updatedAt: string }>()

    expect(response.status).toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(after).toEqual(before)
  })

  it("uses the persisted reauthentication time instead of cookie activity", async () => {
    const cookie = await createOwnerSession({
      reauthenticatedAt: new Date(Date.now() - 16 * 60 * 1000),
    })

    const staleResponse = await requestPasskeyRegistrationOptions(
      `eruoo.session_token=${cookie}`,
    )
    expect(staleResponse.status).toBe(403)

    await updateOnlySessionReauthentication(new Date())

    const recentResponse = await requestPasskeyRegistrationOptions(
      `eruoo.session_token=${cookie}`,
    )
    expect(recentResponse.status).toBe(200)
    expect(await recentResponse.json()).toMatchObject({
      authenticatorSelection: { userVerification: "required" },
      rp: { id: "localhost" },
    })
  })

  it("rejects a signed cookie immediately after its D1 Session is revoked", async () => {
    const cookie = await createOwnerSession()
    await env.DB.prepare("DELETE FROM session").run()

    const response = await SELF.fetch("http://local.test/api/status", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })

    expect(response.status).toBe(401)
  })

  it("serves Session reads from the cookie cache after the D1 Session is revoked", async () => {
    const tokenCookie = await createOwnerSession()

    const initial = await SELF.fetch("http://local.test/api/auth/get-session", {
      headers: { cookie: `eruoo.session_token=${tokenCookie}` },
    })
    expect(initial.status).toBe(200)
    const sessionDataCookie = initial.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .find((value) => value.startsWith("eruoo.session_data="))

    expect(sessionDataCookie).toBeDefined()

    await env.DB.prepare("DELETE FROM session").run()

    const cached = await SELF.fetch("http://local.test/api/auth/get-session", {
      headers: {
        cookie: `eruoo.session_token=${tokenCookie}; ${sessionDataCookie}`,
      },
    })

    expect(cached.status).toBe(200)
    await expect(cached.json()).resolves.toMatchObject({
      session: expect.objectContaining({ userId: expect.any(String) }),
      user: expect.objectContaining({ id: expect.any(String) }),
    })
  })

  it("bypasses the cookie cache for sensitive operations after revocation", async () => {
    const tokenCookie = await createOwnerSession()

    const initial = await SELF.fetch("http://local.test/api/auth/get-session", {
      headers: { cookie: `eruoo.session_token=${tokenCookie}` },
    })
    const sessionDataCookie = initial.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .find((value) => value.startsWith("eruoo.session_data="))

    expect(sessionDataCookie).toBeDefined()

    await env.DB.prepare("DELETE FROM session").run()

    const sensitiveResponse = await requestPasskeyRegistrationOptions(
      `eruoo.session_token=${tokenCookie}; ${sessionDataCookie}`,
    )

    expect(sensitiveResponse.status).toBe(401)
  })

  it("requires re-login when the primary Session cookie secret rotates", async () => {
    const oldSecret =
      "synthetic-old-session-secret-at-least-thirty-two-characters"
    const newSecret =
      "synthetic-new-session-secret-at-least-thirty-two-characters"
    const cookie = await createOwnerSession({ secret: oldSecret })
    const request = () =>
      new Request("http://local.test/api/status", {
        headers: { cookie: `eruoo.session_token=${cookie}` },
      })

    const beforeRotation = await createApp().fetch(
      request(),
      workerEnvWithSecrets(`1:${oldSecret}`),
    )
    const withOldSecretRetained = await createApp().fetch(
      request(),
      workerEnvWithSecrets(`2:${newSecret},1:${oldSecret}`),
    )
    const afterOldSecretRemoval = await createApp().fetch(
      request(),
      workerEnvWithSecrets(`2:${newSecret}`),
    )

    expect(beforeRotation.status).toBe(200)
    expect(withOldSecretRetained.status).toBe(401)
    expect(afterOldSecretRemoval.status).toBe(401)
  })

  it("rejects a persisted Session after its owner account mapping changes", async () => {
    const cookie = await createOwnerSession()
    await env.DB.prepare("UPDATE account SET accountId = '123'").run()

    const response = await SELF.fetch("http://local.test/api/status", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })

    expect(response.status).toBe(401)
  })
})

describe("Passkey user-verification enforcement", () => {
  const options = createAuthOptions(productionAuthEnv(), env.DB)
  const passkeyOptions = requirePasskeyOptions(options)
  const registrationVerification =
    passkeyOptions.registration?.afterVerification
  const authenticationVerification =
    passkeyOptions.authentication?.afterVerification

  if (!registrationVerification || !authenticationVerification) {
    throw new Error("Passkey verification callbacks are not configured.")
  }

  it("requires user verification in generated authenticator options", () => {
    expect(passkeyOptions.authenticatorSelection).toMatchObject({
      userVerification: "required",
    })
  })

  it("rejects a registration result without authenticator user verification", () => {
    const verify = () =>
      registrationVerification({
        clientData: undefined as never,
        ctx: undefined as never,
        user: undefined as never,
        verification: {
          registrationInfo: { userVerified: false },
        } as never,
      })

    const error = captureError(verify)

    expect(error.message).toBe("The authenticator must verify the user.")
    expect(error).toMatchObject({
      body: { code: "USER_VERIFICATION_REQUIRED" },
      status: "UNAUTHORIZED",
      statusCode: 401,
    })
  })

  it("rejects an authentication result without authenticator user verification", () => {
    const verify = () =>
      authenticationVerification({
        clientData: undefined as never,
        ctx: undefined as never,
        verification: {
          authenticationInfo: { userVerified: false },
        } as never,
      })

    const error = captureError(verify)

    expect(error.message).toBe("The authenticator must verify the user.")
    expect(error).toMatchObject({
      body: { code: "USER_VERIFICATION_REQUIRED" },
      status: "UNAUTHORIZED",
      statusCode: 401,
    })
  })

  it("allows verified registration and authentication results", () => {
    expect(
      registrationVerification({
        clientData: undefined as never,
        ctx: undefined as never,
        user: undefined as never,
        verification: {
          registrationInfo: { userVerified: true },
        } as never,
      }),
    ).toBeUndefined()
    expect(
      authenticationVerification({
        clientData: undefined as never,
        ctx: undefined as never,
        verification: {
          authenticationInfo: { userVerified: true },
        } as never,
      }),
    ).toBeUndefined()
  })
})

describe("GET /api/status dependency failure", () => {
  it("returns a generic 503 when its D1 Session dependency fails", async () => {
    const cookie = await createOwnerSession()
    const unavailableDatabase = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return () => {
            throw new Error("synthetic D1 dependency failure")
          }
        }

        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const unavailableEnv: WorkerAuthEnv = {
      ALLOWED_CORS_ORIGINS: env.ALLOWED_CORS_ORIGINS,
      APP_ENV: env.APP_ENV,
      APP_ORIGIN: env.APP_ORIGIN,
      AUDIT_IP_HASH_SECRET: env.AUDIT_IP_HASH_SECRET,
      BETTER_AUTH_SECRETS: env.BETTER_AUTH_SECRETS,
      DB: unavailableDatabase,
      GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
      OWNER_GITHUB_ID: env.OWNER_GITHUB_ID,
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const response = await createApp().fetch(
        new Request("http://local.test/api/status", {
          headers: { cookie: `eruoo.session_token=${cookie}` },
        }),
        unavailableEnv,
      )

      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(await response.json()).toMatchObject({
        detail: "The session could not be verified.",
        status: 503,
        title: "Service unavailable",
        type: "https://auth.eruoo.me/problems/service-unavailable",
      })
      expect(consoleError).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "session_dependency_failed",
          message: expect.any(String),
        }),
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})

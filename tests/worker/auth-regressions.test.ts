import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import worker from "../../src/worker"
import { createD1OAuthJwksResolver } from "../../src/worker/oauth/jwks"
import { issueGrant, oauthFetch } from "./fixtures/oauth"
import { ownerSession } from "./fixtures/session"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})

it("elects one signing key for concurrent empty reads and keeps UserInfo available", async () => {
  await env.DB.prepare("DELETE FROM jwks").run()
  const count = 33
  let arrived = 0
  let release!: () => void
  const barrier = new Promise<void>((r) => (release = r))
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(stmt, {
              get(t, p) {
                if (p === "bind")
                  return (...values: unknown[]) => wrap(t.bind(...values))
                if (p === "all")
                  return async () => {
                    const result = await t.all()
                    if (
                      /from\s+["`]?jwks["`]?/i.test(sql) &&
                      result.results.length === 0 &&
                      arrived < count
                    ) {
                      arrived++
                      if (arrived === count) release()
                      await barrier
                    }
                    return result
                  }
                const value = Reflect.get(t, p)
                return typeof value === "function" ? value.bind(t) : value
              },
            })
          return wrap(target.prepare(sql))
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const responses = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const ctx = createExecutionContext()
      const response = await worker.fetch(
        new Request(env.APP_ORIGIN + "/api/auth/jwks", {
          headers: { "cf-connecting-ip": `anonymous-${i}` },
        }),
        { ...env, DB: database },
        ctx,
      )
      await waitOnExecutionContext(ctx)
      return response.status
    }),
  )
  const rows = await env.DB.prepare("SELECT id, alg FROM jwks").all<{
    id: string
    alg: string
  }>()
  let error = ""
  try {
    await createD1OAuthJwksResolver(database)(
      { alg: rows.results[0]!.alg, kid: rows.results[0]!.id },
      { payload: "", signature: "" },
    )
  } catch (e) {
    error = (e as Error).name
  }
  expect(responses.every((status) => status === 200)).toBe(true)
  expect(rows.results.length).toBe(1)
  expect(error).toBe("")
  const owner = await ownerSession()
  const grant = await issueGrant(owner.cookie)
  const userinfo = await oauthFetch("/api/auth/oauth2/userinfo", {
    headers: { authorization: `Bearer ${grant.access_token}` },
  })
  expect(userinfo.status).toBe(200)
}, 30000)

it("rejects API Key updates beyond name without changing persisted fields", async () => {
  const session = await ownerSession()
  async function send(path: string, body: unknown) {
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + path, {
        method: "POST",
        headers: {
          origin: env.APP_ORIGIN,
          "content-type": "application/json",
          cookie: session.cookie,
          "cf-connecting-ip": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    return response
  }
  const created = await send("/api/auth/api-key/create", {
    name: "review",
    expiresIn: 86400,
  })
  const key = await created.json<{ id: string; expiresAt: string }>()
  const updated = await send("/api/auth/api-key/update", {
    keyId: key.id,
    enabled: false,
    expiresIn: 365 * 86400,
  })
  const row = await env.DB.prepare(
    "SELECT enabled,expiresAt FROM apikey WHERE id=?",
  )
    .bind(key.id)
    .first()
  expect(updated.status).toBe(422)
  expect(row?.enabled).toBe(1)
  expect(row?.expiresAt).toBe(key.expiresAt)
  expect(
    (await send("/api/auth/api-key/update", { keyId: key.id, name: "renamed" }))
      .status,
  ).toBe(200)
})

it("returns 504 within the JWKS read budget despite a blocked database", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const db = new Proxy(env.DB, {
    get(target, p) {
      if (p === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!/from\s+["`]?jwks["`]?/i.test(sql)) return statement
          const wrap = (t: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(t, {
              get(s, k) {
                if (k === "bind")
                  return (...args: unknown[]) => wrap(s.bind(...args))
                if (k === "all")
                  return async () => {
                    await gate
                    return s.all()
                  }
                const value = Reflect.get(s, k)
                return typeof value === "function" ? value.bind(s) : value
              },
            })
          return wrap(statement)
        }
      const value = Reflect.get(target, p)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const ctx = createExecutionContext()
  const start = Date.now()
  const pending = worker.fetch(
    new Request(env.APP_ORIGIN + "/api/auth/jwks", {
      headers: { "cf-connecting-ip": "slow-jwks" },
    }),
    { ...env, DB: db },
    ctx,
  )
  const observed = await Promise.race([
    Promise.resolve(pending).then((r) => r.status),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 5500)),
  ])
  release()
  const response = await pending
  await waitOnExecutionContext(ctx)
  expect(observed).toBe(504)
  expect(Date.now() - start).toBeLessThan(5500)
  expect(response.status).toBe(504)
}, 10000)

it.each(["EdDSA", "RS256"] as const)(
  "rotates %s keys once across independent Auth instances and keeps the old public key",
  async (alg) => {
    const { OAUTH_ACCESS_TOKEN_JWKS_OPTIONS } =
      await import("../../src/worker/oauth/access-token")
    const body = {
      payload: { sub: "owner" },
      overrideOptions: {
        jwks: {
          ...OAUTH_ACCESS_TOKEN_JWKS_OPTIONS,
          keyPairConfig:
            alg === "RS256" ? { alg, modulusLength: 2048 as const } : { alg },
        },
      },
    }
    const { createAuth } = await import("../../src/worker/auth")
    const makeAuth = () =>
      createAuth(
        {
          appOrigin: env.APP_ORIGIN,
          betterAuthSecrets: env.BETTER_AUTH_SECRETS,
          githubClientId: env.GITHUB_CLIENT_ID,
          githubClientSecret: env.GITHUB_CLIENT_SECRET,
          ownerGitHubId: env.OWNER_GITHUB_ID,
        },
        env.DB,
      )
    await env.DB.prepare("DELETE FROM jwks").run()
    await makeAuth().api.signJWT({ body })
    const old = await env.DB.prepare("SELECT id, privateKey FROM jwks").first<{
      id: string
      privateKey: string
    }>()
    expect(old).toBeTruthy()
    expect(JSON.parse(old!.privateKey)).not.toHaveProperty("d")
    await env.DB.prepare("UPDATE jwks SET expiresAt=?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run()
    const tokens = await Promise.all(
      Array.from({ length: alg === "RS256" ? 4 : 16 }, () =>
        makeAuth().api.signJWT({ body }),
      ),
    )
    const { decodeProtectedHeader, jwtVerify } = await import("jose")
    const keys = new Set(
      tokens.map(({ token }) => decodeProtectedHeader(token).kid),
    )
    expect(keys.size).toBe(1)
    expect(keys.has(old!.id)).toBe(false)
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM jwks").first("n"),
    ).toBe(2)
    const { createD1OAuthJwksResolver } =
      await import("../../src/worker/oauth/jwks")
    const currentKeyId = [...keys][0]!
    const currentExpiry = await env.DB.prepare(
      "SELECT expiresAt FROM jwks WHERE id=?",
    )
      .bind(currentKeyId)
      .first<string>("expiresAt")
    // Native unpinned signing falls back to an existing live algorithm. Expire it
    // while provisioning the second algorithm, then restore it for coexistence.
    await env.DB.prepare("UPDATE jwks SET expiresAt=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), currentKeyId)
      .run()
    const other = await makeAuth().api.signJWT({
      body: {
        payload: { sub: "owner" },
        overrideOptions: {
          jwks: {
            ...OAUTH_ACCESS_TOKEN_JWKS_OPTIONS,
            keyPairConfig:
              alg === "RS256"
                ? { alg: "EdDSA" }
                : { alg: "RS256", modulusLength: 2048 },
          },
        },
      },
    })
    await env.DB.prepare("UPDATE jwks SET expiresAt=? WHERE id=?")
      .bind(currentExpiry, currentKeyId)
      .run()
    expect(keys.has(decodeProtectedHeader(other.token).kid)).toBe(false)
    expect(decodeProtectedHeader(other.token).alg).toBe(
      alg === "RS256" ? "EdDSA" : "RS256",
    )
    expect(decodeProtectedHeader(tokens[0]!.token).alg).toBe(alg)
    const resolver = createD1OAuthJwksResolver(
      new Proxy(env.DB, {
        get(target, key) {
          const value = Reflect.get(target, key)
          return typeof value === "function" ? value.bind(target) : value
        },
      }),
    )
    for (const { token } of [...tokens, other])
      await expect(
        jwtVerify(token, resolver, { issuer: env.APP_ORIGIN }),
      ).resolves.toHaveProperty("payload.sub", "owner")
  },
)

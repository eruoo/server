import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import worker, { app } from "../../src/worker"
import { createAuth } from "../../src/worker/auth"
import { authRateLimitBucketKey } from "../../src/worker/auth/persistent-rate-limit"
import { getOpenAPIDocument } from "../../src/worker/routes/api-documentation"
import { ownerSession } from "./fixtures/session"

function nativeAuth() {
  return createAuth(
    {
      appOrigin: env.APP_ORIGIN,
      betterAuthSecrets: env.BETTER_AUTH_SECRETS,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET,
      ownerGitHubId: env.OWNER_GITHUB_ID,
    },
    env.DB,
  )
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare("DELETE FROM apikey"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM rateLimit"),
    env.DB.prepare("DELETE FROM security_audit_events"),
  ])
})

let sequence = 0
async function call(
  path: string,
  options: {
    body?: unknown
    cookie?: string
    headers?: Record<string, string>
    rawBody?: string
    customEnv?: typeof env
  } = {},
) {
  const payload =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body))
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`${env.APP_ORIGIN}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        origin: env.APP_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": `key-gateway-${++sequence}`,
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      ...(payload === undefined ? {} : { body: payload }),
    }),
    options.customEnv ?? env,
    context,
  )
  await waitOnExecutionContext(context)
  return response
}

async function createDefaultKey(
  cookie: string,
  body: Record<string, unknown> = { name: "gateway probe", expiresIn: 86400 },
) {
  const response = await call("/api/auth/api-key/create", { cookie, body })
  expect(response.status).toBe(200)
  return response.json<{
    id: string
    key: string
    configId: string
    referenceId: string
  }>()
}

/** Catalog rows for gateway resolution tests (creation paths are covered elsewhere). */
async function seedAiCatalog(): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    // The gateway suite's beforeEach does not own the AI tables; seeding is
    // idempotent so each test starts from the same catalog.
    env.DB.prepare(
      `DELETE FROM "ai_connections" WHERE "id"='11111111-1111-1111-1111-111111111111'`,
    ),
    env.DB.prepare(
      `INSERT INTO "ai_connections" ("id","slug","name","providerType","enabled","authorizationStatus","upstreamAccountId","credentialVersion","credentialCiphertext","credentialExpiresAt","refreshClaimId","refreshClaimExpiresAt","createdAt","updatedAt")
       VALUES (?,?,?,?,1,'connected','account-main',1,'ciphertext',?,NULL,NULL,?,?)`,
    ).bind(
      "11111111-1111-1111-1111-111111111111",
      "codex-main",
      "Main",
      "openai-codex",
      now + 3_600_000,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES ('11111111-1111-1111-1111-111111111111','gpt-test','GPT Test',NULL,1,?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO "ai_models" ("connectionId","upstreamModelId","displayName","capabilities","snapshotCredentialVersion","discoveredAt")
       VALUES ('11111111-1111-1111-1111-111111111111','openai/gpt-other','GPT Other',NULL,1,?)`,
    ).bind(now),
  ])
}

async function insertSyntheticKey(options: {
  configId: string
  referenceId: string
  name?: string
}) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO apikey (id,configId,name,start,referenceId,prefix,key,enabled,expiresAt,createdAt,updatedAt,permissions,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      options.configId,
      options.name ?? "synthetic",
      "eruoo_syn",
      options.referenceId,
      "eruoo_",
      `synthetic-hash-${id}`,
      1,
      new Date(Date.now() + 86_400_000).toISOString(),
      now,
      now,
      JSON.stringify({ status: ["read"] }),
      null,
    )
    .run()
  return id
}

/**
 * 在网关归属预查返回后删除 Key，模拟插件查找前发生的并发撤销；
 * replacementOwner 用于模拟竞态中出现另一 owner 的同 id 资源。
 */
function revokeBeforePluginLookup(
  keyId: string,
  onIntervene: () => void,
  options: { replacementOwner?: string } = {},
) {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      }
      return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.startsWith("SELECT configId, referenceId FROM apikey"))
          return statement
        const wrap = (prepared: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(prepared, {
            get(inner, method) {
              if (method === "bind")
                return (...values: unknown[]) => wrap(inner.bind(...values))
              if (method === "first")
                return async () => {
                  const row = await inner.first()
                  await env.DB.prepare("DELETE FROM apikey WHERE id=?")
                    .bind(keyId)
                    .run()
                  if (options.replacementOwner) {
                    const now = new Date().toISOString()
                    await env.DB.prepare(
                      "INSERT INTO apikey (id,configId,name,referenceId,key,enabled,createdAt,updatedAt,permissions) VALUES (?,?,?,?,?,?,?,?,?)",
                    )
                      .bind(
                        keyId,
                        "default",
                        "replacement",
                        options.replacementOwner,
                        `synthetic-hash-${keyId}`,
                        1,
                        now,
                        now,
                        JSON.stringify({ status: ["read"] }),
                      )
                      .run()
                  }
                  onIntervene()
                  return row
                }
              const value = Reflect.get(inner, method)
              return typeof value === "function" ? value.bind(inner) : value
            },
          })
        return wrap(statement)
      }
    },
  })
}

it("creates, reads, renames and deletes a default profile key through the gateway", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie)
  expect(created.key).toMatch(/^eruoo_/)
  expect(created.configId).toBe("default")
  // 只有服务端调用才会接受 body.userId；携带浏览器 headers 的插件调用会拒绝。
  expect(created.referenceId).toBe(session.id)

  const list = await call("/api/auth/api-key/list", { cookie: session.cookie })
  expect(list.status).toBe(200)
  const listed = await list.json<{
    apiKeys: { id: string; name: string; start: string; key?: string }[]
    total: number
  }>()
  expect(listed.total).toBe(1)
  expect(listed.apiKeys[0]?.id).toBe(created.id)
  expect(listed.apiKeys[0]).not.toHaveProperty("key")
  expect(created.key.startsWith(listed.apiKeys[0]!.start)).toBe(true)

  const explicitList = await call("/api/auth/api-key/list?configId=default", {
    cookie: session.cookie,
  })
  expect(explicitList.status).toBe(200)

  const read = await call(
    `/api/auth/api-key/get?keyId=${created.id}&configId=default`,
    { cookie: session.cookie },
  )
  expect(read.status).toBe(200)
  const readKey = await read.json<{ id: string; name: string; key?: string }>()
  expect(readKey.id).toBe(created.id)
  expect(readKey).not.toHaveProperty("key")

  const implicitRead = await call(`/api/auth/api-key/get?keyId=${created.id}`, {
    cookie: session.cookie,
  })
  expect(implicitRead.status).toBe(200)

  const renamed = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    body: { keyId: created.id, configId: "default", name: "renamed probe" },
  })
  expect(renamed.status).toBe(200)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(created.id)
      .first("name"),
  ).toBe("renamed probe")

  const deleted = await call("/api/auth/api-key/delete", {
    cookie: session.cookie,
    body: { keyId: created.id, configId: "default" },
  })
  expect(deleted.status).toBe(200)
  expect(await deleted.json()).toMatchObject({ success: true })
  expect(
    await env.DB.prepare("SELECT 1 FROM apikey WHERE id=?")
      .bind(created.id)
      .first(),
  ).toBeNull()

  const repeated = await call("/api/auth/api-key/delete", {
    cookie: session.cookie,
    body: { keyId: created.id },
  })
  expect(repeated.status).toBe(200)
  expect(await repeated.json()).toMatchObject({ success: true })
})

it("maps the explicit status purpose to the default profile", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie, {
    name: "explicit status",
    purpose: "status",
    expiresIn: 86400,
  })
  expect(created.configId).toBe("default")
})

it("keeps the plugin's native client error shape for rules the gateway does not own", async () => {
  const session = await ownerSession()
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "x".repeat(33), expiresIn: 86400 },
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ code: "INVALID_NAME_LENGTH" })
})

it("rejects unopened fields, profiles and ambiguous parameters", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie)
  const rejected: [string, { body?: unknown } | undefined][] = [
    ["/api/auth/api-key/create", { body: { name: "x", configId: "default" } }],
    [
      "/api/auth/api-key/create",
      { body: { name: "x", permissions: { status: ["read"] } } },
    ],
    ["/api/auth/api-key/create", { body: { name: "x", userId: session.id } }],
    [
      "/api/auth/api-key/create",
      { body: { name: "x", modelIds: ["codex/gpt"] } },
    ],
    ["/api/auth/api-key/create", { body: { name: "x", purpose: "ai" } }],
    [
      "/api/auth/api-key/create",
      {
        body: {
          modelIds: ["missing-connection/gpt"],
          name: "x",
          purpose: "ai",
        },
      },
    ],
    ["/api/auth/api-key/create", { body: { name: "x", purpose: "unknown" } }],
    ["/api/auth/api-key/list?configId=unknown", undefined],
    [
      "/api/auth/api-key/update",
      {
        body: {
          configId: "default",
          keyId: created.id,
          modelIds: ["codex-main/gpt-test"],
          name: "x",
        },
      },
    ],
    [
      "/api/auth/api-key/update",
      { body: { keyId: created.id, expiresIn: null } },
    ],
    [
      "/api/auth/api-key/update",
      {
        body: {
          keyId: created.id,
          permissions: { status: ["read"] },
          name: "x",
        },
      },
    ],
    [
      "/api/auth/api-key/update",
      { body: { keyId: created.id, userId: session.id, name: "x" } },
    ],
    [`/api/auth/api-key/get?id=${created.id}&configId=default`, undefined],
    ["/api/auth/api-key/list?limit=10", undefined],
    ["/api/auth/api-key/create", { body: { name: "x", expiresIn: 86_399 } }],
    [
      "/api/auth/api-key/create",
      { body: { name: "x", expiresIn: 366 * 86_400 } },
    ],
  ]
  const statuses: [string, number][] = []
  for (const [path, options] of rejected) {
    const response = await call(path, { cookie: session.cookie, ...options })
    statuses.push([path, response.status])
  }
  expect(statuses.filter(([, status]) => status !== 422)).toEqual([])

  const expired = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "x", expiresIn: 86_399 },
  })
  expect((await expired.json<{ type: string }>()).type).toBe(
    "https://auth.eruoo.me/problems/api-key-expiration-required",
  )
  const ambiguous = await call(
    "/api/auth/api-key/list?configId=default&configId=default",
    { cookie: session.cookie },
  )
  expect(ambiguous.status).toBe(400)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(created.id)
      .first("name"),
  ).toBe("gateway probe")
})

it("keeps synthetic keys in another profile invisible and untouchable", async () => {
  const session = await ownerSession()
  const defaultKey = await createDefaultKey(session.cookie)
  const aiKeyId = await insertSyntheticKey({
    configId: "ai",
    referenceId: session.id,
    name: "synthetic ai",
  })

  const list = await call("/api/auth/api-key/list?configId=default", {
    cookie: session.cookie,
  })
  const listed = await list.json<{ apiKeys: { id: string }[]; total: number }>()
  expect(listed.total).toBe(1)
  expect(listed.apiKeys.map((key) => key.id)).toEqual([defaultKey.id])

  expect(
    (
      await call(`/api/auth/api-key/get?keyId=${aiKeyId}&configId=default`, {
        cookie: session.cookie,
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call("/api/auth/api-key/update", {
        cookie: session.cookie,
        body: { keyId: aiKeyId, configId: "default", name: "crossed" },
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call("/api/auth/api-key/delete", {
        cookie: session.cookie,
        body: { keyId: aiKeyId, configId: "default" },
      })
    ).status,
  ).toBe(404)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(aiKeyId)
      .first("name"),
  ).toBe("synthetic ai")
  // The ai profile is open in this slice, so the same-profile delete now
  // succeeds; the default profile above still cannot see or touch the key.
  expect(
    (
      await call("/api/auth/api-key/delete", {
        cookie: session.cookie,
        body: { keyId: aiKeyId, configId: "ai" },
      })
    ).status,
  ).toBe(200)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(aiKeyId)
      .first("name"),
  ).toBeNull()
})

it("keeps managing keys that already exist in the default profile", async () => {
  const session = await ownerSession()
  const legacyKeyId = await insertSyntheticKey({
    configId: "default",
    referenceId: session.id,
    name: "legacy",
  })

  const list = await call("/api/auth/api-key/list", { cookie: session.cookie })
  const listed = await list.json<{ apiKeys: { id: string }[]; total: number }>()
  expect(listed.apiKeys.map((key) => key.id)).toEqual([legacyKeyId])

  expect(
    (
      await call(`/api/auth/api-key/get?keyId=${legacyKeyId}`, {
        cookie: session.cookie,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await call("/api/auth/api-key/update", {
        cookie: session.cookie,
        body: { keyId: legacyKeyId, name: "renamed legacy" },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await call("/api/auth/api-key/delete", {
        cookie: session.cookie,
        body: { keyId: legacyKeyId },
      })
    ).status,
  ).toBe(200)
})

it("keeps the auth entry limiter ahead of the gateway", async () => {
  const session = await ownerSession()
  const limiter = {
    limit: async () => ({ success: false }),
  } as unknown as RateLimit
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "limited", expiresIn: 86400 },
    customEnv: { ...env, AUTH_RATE_LIMITER: limiter },
  })
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("60")
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM apikey").first("count"),
  ).toBe(0)
})

it("rejects another owner's key without deleting it", async () => {
  const session = await ownerSession()
  const foreignKeyId = await insertSyntheticKey({
    configId: "default",
    referenceId: "another-owner",
    name: "foreign",
  })

  expect(
    (
      await call("/api/auth/api-key/delete", {
        cookie: session.cookie,
        body: { keyId: foreignKeyId, configId: "default" },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await call(`/api/auth/api-key/get?keyId=${foreignKeyId}`, {
        cookie: session.cookie,
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call("/api/auth/api-key/update", {
        cookie: session.cookie,
        body: { keyId: foreignKeyId, name: "stolen" },
      })
    ).status,
  ).toBe(404)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(foreignKeyId)
      .first("name"),
  ).toBe("foreign")
})

it("rejects mixed credential carriers and stale recent authentication", async () => {
  const session = await ownerSession()
  const mixed = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
    headers: { "x-api-key": "eruoo_" + "x".repeat(64) },
  })
  expect(mixed.status).toBe(400)

  await env.DB.prepare("UPDATE session SET reauthenticatedAt=? WHERE id=?")
    .bind(new Date(Date.now() - 16 * 60_000).toISOString(), session.id)
    .run()
  const stale = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "stale", expiresIn: 86400 },
  })
  expect(stale.status).toBe(403)
  expect((await stale.json<{ type: string }>()).type).toBe(
    "https://auth.eruoo.me/problems/recent-authentication-required",
  )
  const staleList = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
  })
  expect(staleList.status).toBe(200)
})

it("reports plugin dependency failures as 503 instead of invalid credentials", async () => {
  const session = await ownerSession()
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.toLowerCase().includes("apikey"))
            throw new Error("synthetic database outage")
          return target.prepare(sql)
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const statuses: [string, number][] = []
  for (const [path, body] of [
    ["/api/auth/api-key/list", undefined],
    ["/api/auth/api-key/create", { name: "outage", expiresIn: 86400 }],
  ] as const) {
    const response = await call(path, {
      cookie: session.cookie,
      body,
      customEnv: { ...env, DB: database },
    })
    statuses.push([path, response.status])
  }
  expect(statuses.filter(([, status]) => status !== 503)).toEqual([])
})

it("records audit after the mutation and never replays it on audit failure", async () => {
  const session = await ownerSession()
  await env.DB.prepare("DELETE FROM security_audit_events").run()
  const created = await createDefaultKey(session.cookie, {
    name: "audited",
    expiresIn: 86400,
  })
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM security_audit_events WHERE type='api_key_created' AND subjectId=?",
    )
      .bind(session.id)
      .first("count"),
  ).toBe(1)

  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.toLowerCase().includes("security_audit_events"))
            throw new Error("synthetic audit outage")
          return target.prepare(sql)
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "audit outage", expiresIn: 86400 },
    customEnv: { ...env, DB: database },
  })
  expect(response.status).toBe(200)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM apikey WHERE referenceId=? AND name='audit outage'",
    )
      .bind(session.id)
      .first("count"),
  ).toBe(1)
  expect(
    await env.DB.prepare("SELECT 1 FROM apikey WHERE id=?")
      .bind(created.id)
      .first(),
  ).not.toBeNull()
})

it("forwards session cookies produced while serving a gateway request", async () => {
  const session = await ownerSession({
    expiresAt: new Date(Date.now() + 29 * 86_400_000),
  })
  const response = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
  })
  expect(response.status).toBe(200)
  const cookies = response.headers.getSetCookie()
  expect(
    cookies.some((value) => value.startsWith("eruoo.session_token=")),
  ).toBe(true)
  expect(cookies.some((value) => value.startsWith("eruoo.session_data="))).toBe(
    true,
  )
})

it.each([
  ["GET", "/api/auth/api-key/list", undefined],
  ["GET", "/api/auth/api-key/get?keyId=missing", undefined],
  ["POST", "/api/auth/api-key/create", { name: "limited" }],
  ["POST", "/api/auth/api-key/update", { keyId: "missing", name: "x" }],
  ["POST", "/api/auth/api-key/delete", { keyId: "missing" }],
] as const)(
  "keeps the persistent limiter on %s %s",
  async (method, path, body) => {
    const session = await ownerSession()
    const ip = "192.0.2.77"
    const operation = `${method} ${path.split("?")[0]}`
    await env.DB.prepare(
      "INSERT INTO rateLimit (id,key,count,lastRequest) VALUES (?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        authRateLimitBucketKey(operation, ip),
        100,
        Date.now(),
      )
      .run()
    const response = await call(path, {
      cookie: session.cookie,
      body,
      headers: { "cf-connecting-ip": ip },
    })
    expect(response.status).toBe(429)
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect((await response.json<{ type: string }>()).type).toBe(
      "https://auth.eruoo.me/problems/rate-limit-exceeded",
    )
  },
)

it("counts the persistent bucket per registered operation and trusted IP", async () => {
  const session = await ownerSession()
  const ip = "192.0.2.78"
  const headers = { "cf-connecting-ip": ip }
  await call("/api/auth/api-key/list", { cookie: session.cookie, headers })
  const bucket = await env.DB.prepare(
    "SELECT key, count FROM rateLimit ORDER BY key",
  ).all<{ key: string; count: number }>()
  expect(bucket.results).toEqual([
    { key: authRateLimitBucketKey("GET /api/auth/api-key/list", ip), count: 1 },
  ])

  // query 参数与另一 operation 都不共享桶，也不额外制造桶。
  await call("/api/auth/api-key/list?configId=default", {
    cookie: session.cookie,
    headers,
  })
  const afterQuery = await env.DB.prepare(
    "SELECT key, count FROM rateLimit ORDER BY key",
  ).all<{ key: string; count: number }>()
  expect(afterQuery.results).toEqual([
    { key: authRateLimitBucketKey("GET /api/auth/api-key/list", ip), count: 2 },
  ])

  const other = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
    headers: { "cf-connecting-ip": "192.0.2.79" },
  })
  expect(other.status).toBe(200)
})

it("does not audit a rate limited mutation and never reaches the plugin", async () => {
  const session = await ownerSession()
  const ip = "192.0.2.80"
  await env.DB.prepare(
    "INSERT INTO rateLimit (id,key,count,lastRequest) VALUES (?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      authRateLimitBucketKey("POST /api/auth/api-key/create", ip),
      100,
      Date.now(),
    )
    .run()
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "limited", expiresIn: 86400 },
    headers: { "cf-connecting-ip": ip },
  })
  expect(response.status).toBe(429)
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM apikey").first("count"),
  ).toBe(0)
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM security_audit_events",
    ).first("count"),
  ).toBe(0)
})

it("rejects management requests when the limiter dependency fails", async () => {
  const session = await ownerSession()
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.toLowerCase().includes("ratelimit"))
            throw new Error("synthetic limiter outage")
          return target.prepare(sql)
        }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const response = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
    customEnv: { ...env, DB: database },
  })
  expect(response.status).toBe(503)
})

it("keeps get-session out of the persistent limiter", async () => {
  const session = await ownerSession()
  const response = await call("/api/auth/get-session", {
    cookie: session.cookie,
    headers: { "cf-connecting-ip": "192.0.2.81" },
  })
  expect(response.status).toBe(200)
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM rateLimit").first(
      "count",
    ),
  ).toBe(0)
})

it("shares the native IPv6 /64 bucket with the gateway", async () => {
  const session = await ownerSession()
  const warm = await nativeAuth().handler(
    new Request(`${env.APP_ORIGIN}/api/auth/api-key/list`, {
      headers: {
        cookie: session.cookie,
        origin: env.APP_ORIGIN,
        "cf-connecting-ip": "2001:db8:1234:5678::1",
      },
    }),
  )
  expect(warm.status).toBe(200)
  // 原生 handler 自己建立的桶：IPv6 已按 /64 归并。
  expect(
    (
      await env.DB.prepare("SELECT key, count FROM rateLimit").all<{
        key: string
        count: number
      }>()
    ).results,
  ).toEqual([
    {
      key: "2001:0db8:1234:5678:0000:0000:0000:0000|/api-key/list",
      count: 1,
    },
  ])

  await env.DB.prepare("UPDATE rateLimit SET count=100, lastRequest=?")
    .bind(Date.now())
    .run()
  const gateway = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
    headers: { "cf-connecting-ip": "2001:db8:1234:5678::2" },
  })
  expect(gateway.status).toBe(429)
  expect(Number(gateway.headers.get("retry-after"))).toBeGreaterThan(0)
  // 没有为绕过限制新建桶。
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM rateLimit").first(
      "count",
    ),
  ).toBe(1)

  const otherSubnet = await call("/api/auth/api-key/list", {
    cookie: session.cookie,
    headers: { "cf-connecting-ip": "2001:db8:1234:9999::1" },
  })
  expect(otherSubnet.status).toBe(200)
})

it("rejects duplicate top-level mutation parameters before applying changes", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie, {
    name: "original",
    expiresIn: 86400,
  })
  const keyId = created.id
  const ambiguous: string[] = [
    `{"keyId":"${keyId}","configId":"ai","configId":"default","name":"ambiguous rename"}`,
    `{"keyId":"${keyId}","name":"first","name":"second"}`,
    `{"keyId":"${keyId}","keyId":"${keyId}","name":"duplicate id"}`,
    `{"keyId":"${keyId}","configId":"default","configId":"default"}`,
    `{"name":"first","name":"second"}`,
    `{"name":"x","purpose":"status","purpose":"status"}`,
    `{"keyId":"${keyId}","nam\\u0065":"escaped","name":"plain"}`,
    `{"keyId":"${keyId}","config\\u0049d":"ai","configId":"default","name":"x"}`,
  ]
  const statuses: [string, number][] = []
  for (const rawBody of ambiguous) {
    const path = rawBody.includes("keyId")
      ? "/api/auth/api-key/update"
      : "/api/auth/api-key/create"
    const response = await call(path, { cookie: session.cookie, rawBody })
    statuses.push([rawBody, response.status])
  }
  expect(statuses.filter(([, status]) => status !== 400)).toEqual([])
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(keyId)
      .first("name"),
  ).toBe("original")
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM apikey").first("count"),
  ).toBe(1)
})

it("still accepts a single escaped field name", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie, {
    name: "original",
    expiresIn: 86400,
  })
  const response = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    rawBody: `{"keyId":"${created.id}","nam\\u0065":"escaped rename"}`,
  })
  expect(response.status).toBe(200)
  expect(
    await env.DB.prepare("SELECT name FROM apikey WHERE id=?")
      .bind(created.id)
      .first("name"),
  ).toBe("escaped rename")
})

it("keeps a revocation idempotent when the key disappears before the plugin lookup", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie)
  let intervened = false
  const database = revokeBeforePluginLookup(created.id, () => {
    intervened = true
  })
  const response = await call("/api/auth/api-key/delete", {
    cookie: session.cookie,
    body: { keyId: created.id },
    customEnv: { ...env, DB: database },
  })
  expect(intervened).toBe(true)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ success: true })
  expect(
    await env.DB.prepare("SELECT 1 FROM apikey WHERE id=?")
      .bind(created.id)
      .first(),
  ).toBeNull()
})

it("keeps rejecting a cross-owner key that appears during the revocation race", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie)
  const database = revokeBeforePluginLookup(created.id, () => undefined, {
    replacementOwner: "another-owner",
  })
  const response = await call("/api/auth/api-key/delete", {
    cookie: session.cookie,
    body: { keyId: created.id },
    customEnv: { ...env, DB: database },
  })
  expect(response.status).toBe(404)
  expect(
    await env.DB.prepare("SELECT referenceId FROM apikey WHERE id=?")
      .bind(created.id)
      .first("referenceId"),
  ).toBe("another-owner")
})

it("reports a revocation confirmation database outage as a dependency failure", async () => {
  const session = await ownerSession()
  const created = await createDefaultKey(session.cookie)
  const revoking = revokeBeforePluginLookup(created.id, () => undefined)
  const database = new Proxy(revoking, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      }
      return (sql: string) => {
        if (sql.startsWith("SELECT 1 FROM apikey"))
          throw new Error("synthetic confirmation outage")
        return target.prepare(sql)
      }
    },
  })
  const response = await call("/api/auth/api-key/delete", {
    cookie: session.cookie,
    body: { keyId: created.id },
    customEnv: { ...env, DB: database },
  })
  expect(response.status).toBe(503)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  const body = await response.json<{
    type: string
    status: number
    requestId: string
    detail: string
  }>()
  expect(body.type).toBe("https://auth.eruoo.me/problems/service-unavailable")
  expect(body.status).toBe(503)
  expect(body.requestId).toBeTruthy()
  expect(body.detail).not.toContain("synthetic")
})

it("creates an ai profile key with server-built model permissions", async () => {
  await seedAiCatalog()
  const session = await ownerSession()
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: {
      modelIds: ["codex-main/gpt-test", "codex-main/openai/gpt-other"],
      name: "ai key",
      purpose: "ai",
    },
  })
  expect(response.status).toBe(200)
  const created = await response.json<{ configId: string; id: string }>()
  expect(created.configId).toBe("ai")
  const stored = await env.DB.prepare(
    "SELECT permissions FROM apikey WHERE id=?",
  )
    .bind(created.id)
    .first<{ permissions: string }>()
  expect(JSON.parse(stored?.permissions ?? "{}")).toEqual({
    ai: ["invoke", "models:read"],
    "ai-model:11111111-1111-1111-1111-111111111111": [
      "gpt-test",
      "openai/gpt-other",
    ],
  })
  // §7 metadata: the profile and the number of granted models are recorded
  // on the reused key audit event.
  const audit = await env.DB.prepare(
    "SELECT type, metadata FROM security_audit_events WHERE type='api_key_created'",
  ).first<{ metadata: string; type: string }>()
  expect(JSON.parse(audit?.metadata ?? "{}")).toMatchObject({
    configId: "ai",
    modelGrantCount: 2,
    status: 200,
  })

  // The ai key is invisible to the default profile and vice versa.
  const defaultList = await call("/api/auth/api-key/list?configId=default", {
    cookie: session.cookie,
  })
  const defaultBody = await defaultList.json<{ apiKeys: { id: string }[] }>()
  expect(defaultBody.apiKeys.map((key) => key.id)).not.toContain(created.id)
  const aiList = await call("/api/auth/api-key/list?configId=ai", {
    cookie: session.cookie,
  })
  const aiBody = await aiList.json<{ apiKeys: { id: string }[] }>()
  expect(aiBody.apiKeys.map((key) => key.id)).toContain(created.id)
})

it("replaces and revokes ai model grants through update", async () => {
  await seedAiCatalog()
  const session = await ownerSession()
  const created = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { modelIds: ["codex-main/gpt-test"], name: "ai key", purpose: "ai" },
  }).then((response) => response.json<{ id: string }>())

  const replaced = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    body: {
      configId: "ai",
      keyId: created.id,
      modelIds: ["codex-main/openai/gpt-other"],
      name: "ai key renamed",
    },
  })
  expect(replaced.status).toBe(200)
  const afterReplace = await env.DB.prepare(
    "SELECT name, permissions FROM apikey WHERE id=?",
  )
    .bind(created.id)
    .first<{ name: string; permissions: string }>()
  expect(afterReplace?.name).toBe("ai key renamed")
  expect(JSON.parse(afterReplace?.permissions ?? "{}")).toEqual({
    ai: ["invoke", "models:read"],
    "ai-model:11111111-1111-1111-1111-111111111111": ["openai/gpt-other"],
  })

  // An omitted selection keeps the grant; an empty one revokes every model.
  const kept = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    body: { configId: "ai", keyId: created.id, name: "ai key renamed again" },
  })
  expect(kept.status).toBe(200)
  const afterKeep = await env.DB.prepare(
    "SELECT permissions FROM apikey WHERE id=?",
  )
    .bind(created.id)
    .first<{ permissions: string }>()
  expect(JSON.parse(afterKeep?.permissions ?? "{}")).toMatchObject({
    "ai-model:11111111-1111-1111-1111-111111111111": ["openai/gpt-other"],
  })

  const revoked = await call("/api/auth/api-key/update", {
    cookie: session.cookie,
    body: { configId: "ai", keyId: created.id, modelIds: [], name: "ai key" },
  })
  expect(revoked.status).toBe(200)
  const afterRevoke = await env.DB.prepare(
    "SELECT permissions FROM apikey WHERE id=?",
  )
    .bind(created.id)
    .first<{ permissions: string }>()
  expect(JSON.parse(afterRevoke?.permissions ?? "{}")).toEqual({
    ai: ["invoke", "models:read"],
  })
})

it("documents both the application Problem and the real plugin error", async () => {
  const session = await ownerSession()
  const response = await call("/api/auth/api-key/create", {
    cookie: session.cookie,
    body: { name: "x".repeat(33), expiresIn: 86400 },
  })
  expect(response.status).toBe(400)
  const mediaType = response.headers.get("content-type")!.split(";")[0]!
  expect(mediaType).toBe("application/json")
  const body = await response.json<Record<string, unknown>>()
  expect(Object.keys(body).sort()).toEqual(["code", "message"])

  const document = getOpenAPIDocument(app) as unknown as {
    components: { schemas: Record<string, Record<string, unknown>> }
    paths: Record<
      string,
      Record<
        string,
        {
          responses: Record<
            string,
            { content: Record<string, { schema: Record<string, unknown> }> }
          >
        }
      >
    >
  }
  const operations: [string, string][] = [
    ["/api/auth/api-key/create", "post"],
    ["/api/auth/api-key/list", "get"],
    ["/api/auth/api-key/get", "get"],
    ["/api/auth/api-key/update", "post"],
    ["/api/auth/api-key/delete", "post"],
  ]
  const mismatches: string[] = []
  for (const [path, method] of operations) {
    const content = document.paths[path]![method]!.responses.default!.content
    if (
      Object.keys(content).sort().join(",") !==
      "application/json,application/problem+json"
    )
      mismatches.push(`${path} media types`)
    const schema = content[mediaType]!.schema
    const reference = schema["$ref"]
    const resolved =
      typeof reference === "string"
        ? document.components.schemas[reference.split("/").pop()!]!
        : schema
    if (!(resolved["required"] as string[]).includes("message"))
      mismatches.push(`${path} required`)
    const properties = Object.keys(resolved["properties"] as object)
    for (const key of Object.keys(body))
      if (!properties.includes(key)) mismatches.push(`${path} property ${key}`)
  }
  expect(mismatches).toEqual([])
})

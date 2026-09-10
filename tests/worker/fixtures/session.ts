import { env } from "cloudflare:test"

export async function ownerSession(
  options: { updatedAt?: Date; expiresAt?: Date } = {},
) {
  const now = new Date()
  const id = crypto.randomUUID()
  const token = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    ).bind(
      id,
      "Owner",
      `${id}@example.invalid`,
      1,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO account (id,issuer,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      "https://github.com",
      "50254496",
      "github",
      id,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId,reauthenticatedAt) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      id,
      (options.expiresAt ?? new Date(Date.now() + 30 * 86400000)).toISOString(),
      token,
      now.toISOString(),
      (options.updatedAt ?? now).toISOString(),
      id,
      now.toISOString(),
    ),
  ])
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      env.BETTER_AUTH_SECRETS.split(":").slice(1).join(":"),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  )
  return {
    id,
    cookie: `eruoo.session_token=${encodeURIComponent(`${token}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)}`,
  }
}

export function instrumentDatabase(
  database: D1Database,
  beforeQuery: () => Promise<void> | void,
) {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values))
        const value = Reflect.get(target, key)
        if (typeof value !== "function") return value
        return async (...args: unknown[]) => {
          await beforeQuery()
          return Reflect.apply(value, target, args)
        }
      },
    })
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql))
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

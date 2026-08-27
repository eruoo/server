import { env } from "cloudflare:test"

const currentAuthSecret =
  "synthetic-better-auth-secret-used-only-in-worker-tests"

async function signedSessionCookie(
  token: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token))
  const base64Signature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  )

  return encodeURIComponent(`${token}.${base64Signature}`)
}

export async function createOwnerSession(options?: {
  reauthenticatedAt?: Date
  secret?: string
}): Promise<string> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  const userId = crypto.randomUUID()
  const sessionToken = crypto.randomUUID()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, emailVerified, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      userId,
      "Synthetic Owner",
      `${userId}@example.invalid`,
      1,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO account (
         id, issuer, accountId, providerId, userId, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      "https://github.com",
      "50254496",
      "github",
      userId,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO session (
         id, expiresAt, token, createdAt, updatedAt, userId, reauthenticatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      expiresAt.toISOString(),
      sessionToken,
      now.toISOString(),
      now.toISOString(),
      userId,
      (options?.reauthenticatedAt ?? now).toISOString(),
    ),
  ])

  return signedSessionCookie(sessionToken, options?.secret ?? currentAuthSecret)
}

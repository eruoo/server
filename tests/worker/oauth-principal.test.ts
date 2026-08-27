import { env } from "cloudflare:test"
import { Hono } from "hono"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import { createRequireOAuthPrincipal } from "../../src/worker/auth/oauth-principal"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"

const issuer = "http://localhost:5173"
const keyId = "synthetic-oauth-principal-key"
let privateKey: CryptoKey
let publicKey: string

const fixture = new Hono<AppBindings>({ strict: true })
fixture.use("*", requestId)
fixture.use("/api/fixture", createRequireOAuthPrincipal(["api:read"]))
fixture.get("/api/fixture", (context) => context.json(context.var.principal))

function payload(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000)
  return {
    aud: OAUTH_RESOURCE,
    client_id: "eruoo-desktop",
    exp: now + 3_600,
    iat: now,
    iss: issuer,
    jti: crypto.randomUUID(),
    scope: "api:read",
    sub: "synthetic-owner-id",
    ...overrides,
  }
}

async function accessToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(payload(overrides))
    .setProtectedHeader({ alg: "EdDSA", kid: keyId, typ: "at+jwt" })
    .sign(privateKey)
}

async function fetchFixture(
  authorization?: string,
  requestEnv: Env = env,
  extraHeaders?: HeadersInit,
): Promise<Response> {
  return fixture.fetch(
    new Request("http://local.test/api/fixture", {
      headers: {
        ...(authorization ? { authorization } : {}),
        ...extraHeaders,
      },
    }),
    requestEnv,
  )
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  publicKey = JSON.stringify(await exportJWK(pair.publicKey))
})

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jwks").run()
  await env.DB.prepare(
    `INSERT INTO jwks (
       id, publicKey, privateKey, createdAt, alg, crv
     ) VALUES (?1, ?2, ?3, ?4, 'EdDSA', 'Ed25519')`,
  )
    .bind(
      keyId,
      publicKey,
      "synthetic-encrypted-private-key",
      new Date().toISOString(),
    )
    .run()
})

describe("OAuth Principal middleware", () => {
  it("returns only the normalized Principal for a valid production-policy token", async () => {
    const response = await fetchFixture(`Bearer ${await accessToken()}`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      authMethod: "oauth",
      clientId: "eruoo-desktop",
      permissions: [],
      scopes: ["api:read"],
      subject: "synthetic-owner-id",
    })
  })

  it("uses the explicit 60-second production clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const accepted = await accessToken({ iat: now + 59, nbf: now + 59 })
    const rejected = await accessToken({ iat: now + 61, nbf: now + 61 })

    expect((await fetchFixture(`Bearer ${accepted}`)).status).toBe(200)
    expect((await fetchFixture(`Bearer ${rejected}`)).status).toBe(401)
  })

  it("returns RFC 6750 challenges for missing and invalid tokens", async () => {
    const missing = await fetchFixture()
    const invalid = await fetchFixture("Bearer invalid.token.value")

    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer realm="eruoo-api", resource_metadata="${issuer}/.well-known/oauth-protected-resource/api"`,
    )
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    )
  })

  it("returns insufficient_scope with the required scope", async () => {
    const token = await accessToken({ scope: "api:write" })
    const response = await fetchFixture(`Bearer ${token}`)

    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"',
    )
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="api:read"',
    )
  })

  it("rejects mixed credential carriers before token verification", async () => {
    const response = await fetchFixture(`Bearer ${await accessToken()}`, env, {
      "x-api-key": "eruoo_synthetic",
    })

    expect(response.status).toBe(400)
    expect(response.headers.get("www-authenticate")).toContain(
      'realm="eruoo-api"',
    )
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_request"',
    )
  })

  it("rejects a query access token with invalid_request", async () => {
    const response = await fixture.fetch(
      new Request("http://local.test/api/fixture?access_token=synthetic-token"),
      env,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("www-authenticate")).toContain(
      'realm="eruoo-api"',
    )
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_request"',
    )
  })

  it("rejects a form-body access token with invalid_request", async () => {
    const response = await fixture.fetch(
      new Request("http://local.test/api/fixture", {
        body: "access_token=synthetic-token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get("www-authenticate")).toContain(
      'realm="eruoo-api"',
    )
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_request"',
    )
  })

  it("rejects a malformed Bearer carrier with invalid_request", async () => {
    const response = await fetchFixture("Bearer")

    expect(response.status).toBe(400)
    expect(response.headers.get("www-authenticate")).toContain(
      'realm="eruoo-api"',
    )
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_request"',
    )
  })

  it("rejects a signed token issued to a disabled client", async () => {
    const token = await accessToken({ client_id: "eruoo-web" })
    const response = await fetchFixture(`Bearer ${token}`)

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    )
  })

  it("distinguishes JWKS dependency failure from invalid credentials", async () => {
    const failingDatabase = {
      prepare: () => ({
        bind: () => ({
          first: () => Promise.reject(new Error("synthetic D1 failure")),
        }),
      }),
    } as unknown as D1Database
    const requestEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "DB") return failingDatabase
        return Reflect.get(target, property, receiver)
      },
    })
    const token = await new SignJWT(payload())
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "dependency-failure-key",
        typ: "at+jwt",
      })
      .sign(privateKey)
    const response = await fetchFixture(`Bearer ${token}`, requestEnv)

    expect(response.status).toBe(503)
    expect(response.headers.get("www-authenticate")).toBeNull()
  })
})

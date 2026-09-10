import { env } from "cloudflare:test"
import { exportJWK, generateKeyPair } from "jose"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createD1OAuthJwksResolver,
  OAuthJwksDependencyError,
  OAUTH_JWKS_POSITIVE_CACHE_TTL_MS,
} from "../../src/worker/oauth/jwks"

const tokenInput = { payload: "", signature: "" }

async function publicEd25519Jwk(): Promise<string> {
  const { publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  return JSON.stringify(await exportJWK(publicKey))
}

async function insertJwk(
  id: string,
  publicKey: string,
  expiresAt: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jwks (
       id, publicKey, privateKey, createdAt, expiresAt, alg, crv
     ) VALUES (?1, ?2, ?3, ?4, ?5, 'EdDSA', 'Ed25519')`,
  )
    .bind(
      id,
      publicKey,
      "synthetic-encrypted-private-key",
      new Date().toISOString(),
      expiresAt,
    )
    .run()
}

describe("D1 OAuth JWKS resolver", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM jwks").run()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("imports an allowlisted public signing key from D1", async () => {
    const keyId = crypto.randomUUID()
    await insertJwk(keyId, await publicEd25519Jwk())

    const key = await createD1OAuthJwksResolver(
      new Proxy(env.DB, {
        get: (target, property) => {
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      }),
    )({ alg: "EdDSA", kid: keyId }, tokenInput)

    expect(key).toBeInstanceOf(CryptoKey)
    expect((key as CryptoKey).type).toBe("public")
  })

  it("rejects private material and malformed expiration fail closed", async () => {
    const privateMaterialId = crypto.randomUUID()
    const malformedKeyId = crypto.randomUUID()
    const malformedExpirationId = crypto.randomUUID()
    const publicKey = JSON.parse(await publicEd25519Jwk()) as Record<
      string,
      unknown
    >
    await insertJwk(
      privateMaterialId,
      JSON.stringify({ ...publicKey, d: "must-not-be-present" }),
    )
    await insertJwk(
      malformedExpirationId,
      JSON.stringify(publicKey),
      "not-a-date",
    )
    await insertJwk(
      malformedKeyId,
      JSON.stringify({ crv: "Ed25519", kty: "OKP", x: "not-base64!" }),
    )
    const resolver = createD1OAuthJwksResolver(
      new Proxy(env.DB, {
        get: (target, property) => {
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      }),
    )

    await expect(
      resolver({ alg: "EdDSA", kid: privateMaterialId }, tokenInput),
    ).rejects.toBeInstanceOf(OAuthJwksDependencyError)
    await expect(
      resolver({ alg: "EdDSA", kid: malformedExpirationId }, tokenInput),
    ).rejects.toBeInstanceOf(OAuthJwksDependencyError)
    await expect(
      resolver({ alg: "EdDSA", kid: malformedKeyId }, tokenInput),
    ).rejects.toBeInstanceOf(OAuthJwksDependencyError)
  })

  it("negative-caches an unknown kid to avoid repeated D1 lookups", async () => {
    const all = vi
      .fn<() => Promise<{ results: never[] }>>()
      .mockResolvedValue({ results: [] })
    const statement = { all, bind: () => statement }
    const prepare = vi.fn<() => typeof statement>(() => statement)
    const database = { prepare } as unknown as D1Database
    const resolver = createD1OAuthJwksResolver(database)

    await expect(
      resolver({ alg: "EdDSA", kid: "missing-key" }, tokenInput),
    ).rejects.toThrow("unknown")
    await expect(
      resolver({ alg: "EdDSA", kid: "different-missing-key" }, tokenInput),
    ).rejects.toThrow("unknown")

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(all).toHaveBeenCalledTimes(1)
  })

  it("rechecks D1 after the positive-cache TTL and observes key deletion", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"))
    const keyId = "deleted-after-positive-cache"
    let row: JwksRowForTest | null = {
      alg: "EdDSA",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      publicKey: await publicEd25519Jwk(),
    }
    const first = vi.fn<() => Promise<JwksRowForTest | null>>(async () => row)
    const database = {
      prepare: () => ({
        bind() {
          return this
        },
        all: async () => {
          const row = await first()
          return { results: row ? [{ ...row, id: keyId }] : [] }
        },
      }),
    } as unknown as D1Database
    const resolver = createD1OAuthJwksResolver(database)

    await expect(
      resolver({ alg: "EdDSA", kid: keyId }, tokenInput),
    ).resolves.toBeInstanceOf(CryptoKey)
    row = null
    await expect(
      resolver({ alg: "EdDSA", kid: keyId }, tokenInput),
    ).resolves.toBeInstanceOf(CryptoKey)

    vi.advanceTimersByTime(OAUTH_JWKS_POSITIVE_CACHE_TTL_MS + 1)

    await expect(
      resolver({ alg: "EdDSA", kid: keyId }, tokenInput),
    ).rejects.toThrow("unknown")
    expect(first).toHaveBeenCalledTimes(2)
  })

  it("reimports a changed D1 key after the positive-cache TTL", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"))
    const keyId = "changed-after-positive-cache"
    const row: JwksRowForTest = {
      alg: "EdDSA",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      publicKey: await publicEd25519Jwk(),
    }
    const first = vi.fn<() => Promise<JwksRowForTest | null>>(async () => row)
    const database = {
      prepare: () => ({
        bind() {
          return this
        },
        all: async () => {
          const row = await first()
          return { results: row ? [{ ...row, id: keyId }] : [] }
        },
      }),
    } as unknown as D1Database
    const resolver = createD1OAuthJwksResolver(database)
    const cachedKey = await resolver({ alg: "EdDSA", kid: keyId }, tokenInput)
    row.publicKey = await publicEd25519Jwk()

    await expect(
      resolver({ alg: "EdDSA", kid: keyId }, tokenInput),
    ).resolves.toBe(cachedKey)
    vi.advanceTimersByTime(OAUTH_JWKS_POSITIVE_CACHE_TTL_MS + 1)

    await expect(
      resolver({ alg: "EdDSA", kid: keyId }, tokenInput),
    ).resolves.not.toBe(cachedKey)
    expect(first).toHaveBeenCalledTimes(2)
  })

  it("distinguishes D1 dependency failure from an invalid token", async () => {
    const first = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("synthetic D1 failure"))
    const database = {
      prepare: () => ({
        all: first,
        bind() {
          return this
        },
      }),
    } as unknown as D1Database

    await expect(
      createD1OAuthJwksResolver(database)(
        { alg: "EdDSA", kid: "dependency-key" },
        tokenInput,
      ),
    ).rejects.toBeInstanceOf(OAuthJwksDependencyError)
  })
})

interface JwksRowForTest {
  alg: string
  expiresAt: string | null
  publicKey: string
}

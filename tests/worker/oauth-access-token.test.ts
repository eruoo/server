import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  generateSecret,
  SignJWT,
  UnsecuredJWT,
  type JWTPayload,
} from "jose"
import { beforeAll, describe, expect, it, vi } from "vitest"

import {
  InvalidOAuthAccessTokenClaimsError,
  OAUTH_ACCESS_TOKEN_JWKS_OPTIONS,
  OAUTH_ACCESS_TOKEN_MAX_CLOCK_TOLERANCE_SECONDS,
  OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH,
  OAUTH_ACCESS_TOKEN_PRODUCTION_CLOCK_TOLERANCE_SECONDS,
  OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS,
  type OAuthAccessTokenVerificationPolicy,
  verifyOAuthAccessToken,
} from "../../src/worker/auth/oauth-access-token"

const issuer = "https://auth.example.invalid"
const audience = "https://api.example.invalid"
const betterAuthBaseUrl = `${issuer}/api/auth`
const userInfoAudience = `${betterAuthBaseUrl}/oauth2/userinfo`
const scopeAudienceByName = {
  "api:read": audience,
  "api:write": audience,
  offline_access: audience,
  openid: userInfoAudience,
  profile: userInfoAudience,
} as const

async function createSigningFixture(algorithm: "EdDSA" | "RS256") {
  const keyPair = await generateKeyPair(
    algorithm,
    algorithm === "RS256" ? { modulusLength: 2048 } : { crv: "Ed25519" },
  )
  const keyId = `synthetic-${algorithm.toLowerCase()}-key`
  const publicKey = {
    ...(await exportJWK(keyPair.publicKey)),
    alg: algorithm,
    kid: keyId,
    use: "sig",
  }

  return {
    algorithm,
    keyId,
    keyResolver: createLocalJWKSet({ keys: [publicKey] }),
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  }
}

type SigningFixture = Awaited<ReturnType<typeof createSigningFixture>>

let eddsa: SigningFixture
let rs256: SigningFixture

function fixtureFor(algorithm: "EdDSA" | "RS256"): SigningFixture {
  return algorithm === "EdDSA" ? eddsa : rs256
}

function validPayload(): JWTPayload {
  const issuedAt = Math.floor(Date.now() / 1_000)

  return {
    aud: [audience, userInfoAudience],
    azp: "eruoo-desktop",
    client_id: "eruoo-desktop",
    exp: issuedAt + 3_600,
    iat: issuedAt,
    iss: issuer,
    jti: "synthetic-access-token-id",
    scope: "openid profile api:read",
    sub: "synthetic-owner-id",
  }
}

function policyFor(
  fixture: SigningFixture,
  overrides: Partial<OAuthAccessTokenVerificationPolicy> = {},
): OAuthAccessTokenVerificationPolicy {
  return {
    additionalAudienceRequiredScopeByAudience: {
      [userInfoAudience]: "openid",
    },
    audience,
    clockToleranceSeconds: 0,
    issuer,
    keyResolver: fixture.keyResolver,
    scopeAudienceByName,
    ...overrides,
  }
}

async function sign(
  fixture: SigningFixture,
  payload: JWTPayload = validPayload(),
  header: { kid?: string; typ?: string } = {
    kid: fixture.keyId,
    typ: "at+jwt",
  },
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: fixture.algorithm, ...header })
    .sign(fixture.privateKey)
}

beforeAll(async () => {
  ;[eddsa, rs256] = await Promise.all([
    createSigningFixture("EdDSA"),
    createSigningFixture("RS256"),
  ])
}, 30_000)

describe("RFC 9068 OAuth access token profile", () => {
  it.each(["EdDSA", "RS256"] as const)(
    "accepts a valid %s token and returns only the normalized boundary",
    async (algorithm) => {
      const fixture = fixtureFor(algorithm)
      const payload = validPayload()
      const token = await sign(fixture, payload)

      await expect(
        verifyOAuthAccessToken(token, policyFor(fixture)),
      ).resolves.toEqual({
        expiresAtSeconds: payload.exp,
        issuedAtSeconds: payload.iat,
        keyId: fixture.keyId,
        principal: {
          authMethod: "oauth",
          clientId: "eruoo-desktop",
          permissions: [],
          scopes: ["openid", "profile", "api:read"],
          subject: "synthetic-owner-id",
        },
        signingAlgorithm: algorithm,
        tokenId: "synthetic-access-token-id",
      })
    },
  )

  it("locks Better Auth key provisioning to EdDSA primary and RS256 compatibility", () => {
    expect(OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS).toEqual(["EdDSA", "RS256"])
    expect(OAUTH_ACCESS_TOKEN_JWKS_OPTIONS).toEqual({
      disablePrivateKeyEncryption: false,
      gracePeriod: 7 * 24 * 60 * 60,
      keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
      keyPairConfigs: [{ alg: "RS256", modulusLength: 2048 }],
      rotationInterval: 30 * 24 * 60 * 60,
    })
    expect(OAUTH_ACCESS_TOKEN_PRODUCTION_CLOCK_TOLERANCE_SECONDS).toBe(60)
  })

  it("accepts the full RFC media type with case-insensitive comparison", async () => {
    const token = await sign(eddsa, validPayload(), {
      kid: eddsa.keyId,
      typ: "Application/AT+JWT",
    })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).resolves.toMatchObject({ signingAlgorithm: "EdDSA" })
  })

  it.each([undefined, "JWT"])("rejects typ %p", async (typ) => {
    const token = await sign(eddsa, validPayload(), {
      kid: eddsa.keyId,
      ...(typ === undefined ? {} : { typ }),
    })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toThrow(/unexpected "typ" JWT header value/)
  })

  it.each(["iss", "sub", "aud", "exp", "iat", "jti", "client_id", "scope"])(
    "rejects a missing %s claim",
    async (claim) => {
      const payload = validPayload()
      delete payload[claim]
      const token = await sign(eddsa, payload)

      await expect(
        verifyOAuthAccessToken(token, policyFor(eddsa)),
      ).rejects.toThrow(`missing required "${claim}" claim`)
    },
  )

  it.each([
    { field: "sub", value: "" },
    { field: "jti", value: null },
    { field: "client_id", value: 42 },
    { field: "scope", value: "api:read  api:write" },
    { field: "azp", value: "different-client" },
  ])("rejects malformed $field claims", async ({ field, value }) => {
    const payload = { ...validPayload(), [field]: value }
    const token = await sign(eddsa, payload)

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toBeInstanceOf(InvalidOAuthAccessTokenClaimsError)
  })

  it.each([
    { field: "iss", value: 42 },
    { field: "sub", value: 42 },
    { field: "aud", value: 42 },
    { field: "exp", value: "3600" },
    { field: "iat", value: "0" },
    { field: "jti", value: 42 },
    { field: "client_id", value: [] },
    { field: "scope", value: [] },
  ])("rejects an invalid $field claim type", async ({ field, value }) => {
    const token = await sign(eddsa, { ...validPayload(), [field]: value })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toBeInstanceOf(Error)
  })

  it("accepts a resource-only token when all scopes belong to that resource", async () => {
    const token = await sign(eddsa, {
      ...validPayload(),
      aud: audience,
      scope: "api:read api:write",
    })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).resolves.toMatchObject({
      principal: { scopes: ["api:read", "api:write"] },
    })
  })

  it.each([
    ["unknown", [audience, "https://other.example.invalid"]],
    ["duplicate", [audience, userInfoAudience, userInfoAudience]],
  ])("rejects %s audiences", async (_label, audiences) => {
    const token = await sign(eddsa, {
      ...validPayload(),
      aud: audiences,
    })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toBeInstanceOf(InvalidOAuthAccessTokenClaimsError)
  })

  it.each([
    {
      label: "an unknown scope",
      payload: { scope: "openid profile api:delete" },
    },
    {
      label: "a duplicate scope",
      payload: { scope: "openid profile api:read api:read" },
    },
    {
      label: "a scope whose audience is absent",
      payload: { aud: audience, scope: "openid api:read" },
    },
    {
      label: "an additional audience without its activation scope",
      payload: {
        aud: [audience, userInfoAudience],
        scope: "profile api:read",
      },
    },
  ])("rejects $label", async ({ payload }) => {
    const token = await sign(eddsa, { ...validPayload(), ...payload })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toBeInstanceOf(InvalidOAuthAccessTokenClaimsError)
  })

  it.each([3_601, 0, -1])(
    "rejects an invalid token lifetime delta of %s seconds",
    async (lifetime) => {
      const payload = validPayload()
      payload.exp = (payload.iat as number) + lifetime
      const token = await sign(eddsa, payload)

      await expect(
        verifyOAuthAccessToken(token, policyFor(eddsa)),
      ).rejects.toBeInstanceOf(Error)
    },
  )

  it.each([
    { claim: "iss", value: "https://other.example.invalid" },
    { claim: "aud", value: "https://other.example.invalid" },
  ])("rejects an incorrect $claim", async ({ claim, value }) => {
    const token = await sign(eddsa, { ...validPayload(), [claim]: value })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toThrow(`unexpected "${claim}" claim value`)
  })

  it("rejects expired and future-dated tokens", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const expired = await sign(eddsa, {
      ...validPayload(),
      exp: now - 1,
      iat: now - 3_600,
    })
    const futureIssued = await sign(eddsa, {
      ...validPayload(),
      exp: now + 3_700,
      iat: now + 100,
    })
    const futureNotBefore = await sign(eddsa, {
      ...validPayload(),
      nbf: now + 100,
    })

    await expect(
      verifyOAuthAccessToken(expired, policyFor(eddsa)),
    ).rejects.toThrow('"exp" claim timestamp check failed')
    await expect(
      verifyOAuthAccessToken(futureIssued, policyFor(eddsa)),
    ).rejects.toThrow('"iat" claim timestamp check failed')
    await expect(
      verifyOAuthAccessToken(futureNotBefore, policyFor(eddsa)),
    ).rejects.toThrow('"nbf" claim timestamp check failed')
  })

  it("enforces the exact expiration clock-tolerance boundary", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"))

    try {
      const now = Math.floor(Date.now() / 1_000)
      const payload = { ...validPayload(), iat: now - 100 }
      const insideTolerance = await sign(eddsa, {
        ...payload,
        exp: now - 59,
      })
      const atBoundary = await sign(eddsa, {
        ...payload,
        exp: now - 60,
      })
      const policy = policyFor(eddsa, { clockToleranceSeconds: 60 })

      await expect(
        verifyOAuthAccessToken(insideTolerance, policy),
      ).resolves.toMatchObject({ expiresAtSeconds: now - 59 })
      await expect(verifyOAuthAccessToken(atBoundary, policy)).rejects.toThrow(
        '"exp" claim timestamp check failed',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects nbf at or after exp even within clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const payload = { ...validPayload(), exp: now + 30, iat: now }
    const token = await sign(eddsa, {
      ...payload,
      nbf: payload.exp,
    })

    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { clockToleranceSeconds: 60 }),
      ),
    ).rejects.toBeInstanceOf(InvalidOAuthAccessTokenClaimsError)
  })

  it.each([
    {
      error: "The access token signing header is incomplete.",
      kid: undefined,
      label: "missing",
    },
    {
      error: "The access token signing header is incomplete.",
      kid: "",
      label: "blank",
    },
    {
      error: "no applicable key found in the JSON Web Key Set",
      kid: "unknown-key",
      label: "unknown",
    },
  ])("rejects a $label kid", async ({ error, kid }) => {
    const token = await sign(eddsa, validPayload(), {
      ...(kid === undefined ? {} : { kid }),
      typ: "at+jwt",
    })

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa)),
    ).rejects.toThrow(error)
  })

  it("rejects symmetric and non-allowlisted asymmetric algorithms", async () => {
    const symmetricKey = await generateSecret("HS256")
    const symmetric = await new SignJWT(validPayload())
      .setProtectedHeader({ alg: "HS256", kid: "symmetric-key", typ: "at+jwt" })
      .sign(symmetricKey)
    const ecKeyPair = await generateKeyPair("ES256")
    const ec = await new SignJWT(validPayload())
      .setProtectedHeader({ alg: "ES256", kid: "ec-key", typ: "at+jwt" })
      .sign(ecKeyPair.privateKey)

    await expect(
      verifyOAuthAccessToken(symmetric, policyFor(eddsa)),
    ).rejects.toThrow('"alg" (Algorithm) Header Parameter value not allowed')
    await expect(verifyOAuthAccessToken(ec, policyFor(eddsa))).rejects.toThrow(
      '"alg" (Algorithm) Header Parameter value not allowed',
    )
  })

  it("rejects wrong signatures and an algorithm/key-type mismatch", async () => {
    const otherEdDsa = await createSigningFixture("EdDSA")
    const wrongSignature = await sign(otherEdDsa, validPayload(), {
      kid: eddsa.keyId,
      typ: "at+jwt",
    })
    const rsaToken = await sign(rs256)

    await expect(
      verifyOAuthAccessToken(wrongSignature, policyFor(eddsa)),
    ).rejects.toThrow("signature verification failed")
    await expect(
      verifyOAuthAccessToken(
        rsaToken,
        policyFor(rs256, { keyResolver: async () => eddsa.publicKey }),
      ),
    ).rejects.toThrow(/CryptoKey does not support this operation/)
  })

  it("rejects an opaque or unsecured token", async () => {
    const unsecured = new UnsecuredJWT(validPayload()).encode()

    await expect(
      verifyOAuthAccessToken("synthetic-opaque-token", policyFor(eddsa)),
    ).rejects.toThrow("Invalid Compact JWS")
    await expect(
      verifyOAuthAccessToken(unsecured, policyFor(eddsa)),
    ).rejects.toThrow('"alg" (Algorithm) Header Parameter value not allowed')
  })

  it("requires an explicit valid issuer, audience, clock tolerance, and resolver", async () => {
    const token = await sign(eddsa)

    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa, { issuer: "" })),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa, { audience: "" })),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { clockToleranceSeconds: -1 }),
      ),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { keyResolver: undefined as never }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it("rejects unsafe issuer, audience, tolerance, and resource-policy configuration", async () => {
    const token = await sign(eddsa)

    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { issuer: "http://auth.example.invalid" }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { issuer: `${issuer}?tenant=other` }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(token, policyFor(eddsa, { issuer: `${issuer}?` })),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { audience: `${audience}#fragment` }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, { audience: `${audience}#` }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, {
          clockToleranceSeconds:
            OAUTH_ACCESS_TOKEN_MAX_CLOCK_TOLERANCE_SECONDS + 1,
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, {
          additionalAudienceRequiredScopeByAudience: {
            [audience]: "api:read",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, {
          additionalAudienceRequiredScopeByAudience: {
            [userInfoAudience]: "api:read",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, {
          scopeAudienceByName: {
            "api:read": "https://unregistered.example.invalid",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it.each([
    { kid: 123, label: "non-string" },
    { kid: " ", label: "whitespace-only" },
    { kid: " leading-space", label: "non-canonical" },
    {
      kid: "k".repeat(OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH + 1),
      label: "oversized",
    },
  ])("rejects a $label kid before key resolution", async ({ kid }) => {
    let keyResolutionCalls = 0
    const token = await new SignJWT(validPayload())
      .setProtectedHeader({
        alg: eddsa.algorithm,
        kid: kid as string,
        typ: "at+jwt",
      })
      .sign(eddsa.privateKey)

    await expect(
      verifyOAuthAccessToken(
        token,
        policyFor(eddsa, {
          keyResolver: async () => {
            keyResolutionCalls += 1
            return eddsa.publicKey
          },
        }),
      ),
    ).rejects.toThrow("The access token signing header is incomplete.")
    expect(keyResolutionCalls).toBe(0)
  })
})

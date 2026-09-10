import type { JwtOptions } from "better-auth/plugins"
import {
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose"
import { z } from "zod"

import type { Principal } from "../../shared/principal"

export const OAUTH_ACCESS_TOKEN_TYPE = "at+jwt"
export const OAUTH_ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 60
export const OAUTH_ACCESS_TOKEN_MAX_CLOCK_TOLERANCE_SECONDS = 5 * 60
export const OAUTH_ACCESS_TOKEN_PRODUCTION_CLOCK_TOLERANCE_SECONDS = 60
export const OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH = 128
export const OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS = ["EdDSA", "RS256"] as const
export const OAUTH_ACCESS_TOKEN_REQUIRED_CLAIMS = [
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "jti",
  "client_id",
  "scope",
] as const

const dayInSeconds = 24 * 60 * 60
const scopeTokenPattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/
const numericDateSchema = z.number().finite().int().nonnegative()
const audienceSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
])
const scopeClaimSchema = z.string().refine(
  (scope) => {
    const tokens = scope.split(" ")
    return (
      tokens.length > 0 &&
      tokens.every((token) => scopeTokenPattern.test(token))
    )
  },
  { message: "scope must contain valid space-delimited OAuth scope tokens" },
)
const accessTokenPayloadSchema = z
  .object({
    aud: audienceSchema,
    azp: z.string().min(1).optional(),
    client_id: z.string().min(1),
    exp: numericDateSchema,
    iat: numericDateSchema,
    iss: z.string().min(1),
    jti: z.string().min(1),
    nbf: numericDateSchema.optional(),
    scope: scopeClaimSchema,
    sub: z.string().min(1),
  })
  .superRefine((payload, context) => {
    if (payload.exp <= payload.iat) {
      context.addIssue({
        code: "custom",
        message: "exp must be later than iat",
        path: ["exp"],
      })
    }

    if (payload.exp - payload.iat > OAUTH_ACCESS_TOKEN_MAX_AGE_SECONDS) {
      context.addIssue({
        code: "custom",
        message: "access token lifetime must not exceed one hour",
        path: ["exp"],
      })
    }

    if (payload.azp !== undefined && payload.azp !== payload.client_id) {
      context.addIssue({
        code: "custom",
        message: "azp must match client_id when present",
        path: ["azp"],
      })
    }

    if (payload.nbf !== undefined && payload.nbf >= payload.exp) {
      context.addIssue({
        code: "custom",
        message: "nbf must be earlier than exp",
        path: ["nbf"],
      })
    }
  })

export const OAUTH_ACCESS_TOKEN_JWKS_OPTIONS = {
  disablePrivateKeyEncryption: false,
  gracePeriod: 7 * dayInSeconds,
  keyPairConfig: { alg: "EdDSA", crv: "Ed25519" },
  keyPairConfigs: [{ alg: "RS256", modulusLength: 2048 }],
  rotationInterval: 30 * dayInSeconds,
} as const satisfies NonNullable<JwtOptions["jwks"]>

export interface OAuthAccessTokenVerificationPolicy {
  additionalAudienceRequiredScopeByAudience: Readonly<Record<string, string>>
  audience: string
  clockToleranceSeconds: number
  issuer: string
  keyResolver: JWTVerifyGetKey
  scopeAudienceByName: Readonly<Record<string, string>>
}

export interface VerifiedOAuthAccessToken {
  expiresAtSeconds: number
  issuedAtSeconds: number
  keyId: string
  notBeforeSeconds?: number
  principal: Principal
  signingAlgorithm: (typeof OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS)[number]
  tokenId: string
}

export class InvalidOAuthAccessTokenClaimsError extends Error {
  override readonly name = "InvalidOAuthAccessTokenClaimsError"
}

function parseKeyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH ||
    value.trim() !== value
  ) {
    throw new InvalidOAuthAccessTokenClaimsError(
      "The access token signing header is incomplete.",
    )
  }

  return value
}

interface ValidatedOAuthAccessTokenPolicy {
  additionalAudienceRequiredScopeByAudience: ReadonlyMap<string, string>
  allowedAudiences: ReadonlySet<string>
  resourceAudience: string
  scopeAudienceByName: ReadonlyMap<string, string>
  verifyOptions: JWTVerifyOptions
}

interface ParsedAccessTokenPayload {
  claims: z.infer<typeof accessTokenPayloadSchema>
  scopes: string[]
}

function parseAbsoluteUri(value: string, label: string): URL {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty absolute URI`)
  }

  try {
    return new URL(value)
  } catch {
    throw new TypeError(`${label} must be a non-empty absolute URI`)
  }
}

function assertIssuer(value: string): void {
  const issuer = parseAbsoluteUri(value, "issuer")
  const isLoopbackHttp =
    issuer.protocol === "http:" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(issuer.hostname)

  if (
    (issuer.protocol !== "https:" && !isLoopbackHttp) ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "issuer must be an HTTPS URI without credentials, query, or fragment; loopback HTTP is allowed for local development",
    )
  }
}

function assertResourceIdentifier(value: string, label: string): void {
  const resource = parseAbsoluteUri(value, label)

  if (
    resource.username !== "" ||
    resource.password !== "" ||
    resource.hash !== "" ||
    value.includes("#")
  ) {
    throw new TypeError(`${label} must not contain credentials or a fragment`)
  }
}

function validatePolicy(
  policy: OAuthAccessTokenVerificationPolicy,
): ValidatedOAuthAccessTokenPolicy {
  assertIssuer(policy.issuer)
  assertResourceIdentifier(policy.audience, "audience")

  if (
    !Number.isSafeInteger(policy.clockToleranceSeconds) ||
    policy.clockToleranceSeconds < 0 ||
    policy.clockToleranceSeconds >
      OAUTH_ACCESS_TOKEN_MAX_CLOCK_TOLERANCE_SECONDS
  ) {
    throw new RangeError(
      `clockToleranceSeconds must be an explicit safe integer between 0 and ${OAUTH_ACCESS_TOKEN_MAX_CLOCK_TOLERANCE_SECONDS}`,
    )
  }

  if (typeof policy.keyResolver !== "function") {
    throw new TypeError("keyResolver must be provided")
  }

  const allowedAudiences = new Set([policy.audience])

  if (
    policy.additionalAudienceRequiredScopeByAudience === null ||
    typeof policy.additionalAudienceRequiredScopeByAudience !== "object" ||
    Array.isArray(policy.additionalAudienceRequiredScopeByAudience)
  ) {
    throw new TypeError(
      "additionalAudienceRequiredScopeByAudience must be an explicit audience map",
    )
  }

  const additionalAudienceRequiredScopeByAudience = new Map(
    Object.entries(policy.additionalAudienceRequiredScopeByAudience),
  )

  for (const [
    additionalAudience,
    requiredScope,
  ] of additionalAudienceRequiredScopeByAudience) {
    assertResourceIdentifier(additionalAudience, "additional audience")

    if (allowedAudiences.has(additionalAudience)) {
      throw new TypeError("allowed audiences must be unique")
    }

    if (!scopeTokenPattern.test(requiredScope)) {
      throw new TypeError(
        `additional audience ${additionalAudience} has an invalid required scope`,
      )
    }

    allowedAudiences.add(additionalAudience)
  }

  if (
    policy.scopeAudienceByName === null ||
    typeof policy.scopeAudienceByName !== "object" ||
    Array.isArray(policy.scopeAudienceByName)
  ) {
    throw new TypeError("scopeAudienceByName must be an explicit scope map")
  }

  const scopeAudienceByName = new Map(
    Object.entries(policy.scopeAudienceByName),
  )

  if (scopeAudienceByName.size === 0) {
    throw new TypeError("scopeAudienceByName must define at least one scope")
  }

  for (const [scope, scopeAudience] of scopeAudienceByName) {
    if (!scopeTokenPattern.test(scope)) {
      throw new TypeError(
        `scopeAudienceByName contains an invalid scope: ${scope}`,
      )
    }

    if (!allowedAudiences.has(scopeAudience)) {
      throw new TypeError(
        `scopeAudienceByName maps ${scope} to an audience outside the allowlist`,
      )
    }
  }

  for (const [
    additionalAudience,
    requiredScope,
  ] of additionalAudienceRequiredScopeByAudience) {
    if (scopeAudienceByName.get(requiredScope) !== additionalAudience) {
      throw new TypeError(
        `additional audience ${additionalAudience} requires a scope that is not mapped back to it`,
      )
    }
  }

  return {
    additionalAudienceRequiredScopeByAudience,
    allowedAudiences,
    resourceAudience: policy.audience,
    scopeAudienceByName,
    verifyOptions: {
      algorithms: [...OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS],
      audience: policy.audience,
      clockTolerance: policy.clockToleranceSeconds,
      issuer: policy.issuer,
      maxTokenAge: OAUTH_ACCESS_TOKEN_MAX_AGE_SECONDS,
      requiredClaims: [...OAUTH_ACCESS_TOKEN_REQUIRED_CLAIMS],
      typ: OAUTH_ACCESS_TOKEN_TYPE,
    },
  }
}

function parseVerifiedPayload(
  payload: JWTPayload,
  policy: ValidatedOAuthAccessTokenPolicy,
): ParsedAccessTokenPayload {
  const result = accessTokenPayloadSchema.safeParse(payload)

  if (!result.success) {
    throw new InvalidOAuthAccessTokenClaimsError(
      "The access token claims do not satisfy the RFC 9068 profile.",
    )
  }

  const audiences = Array.isArray(result.data.aud)
    ? result.data.aud
    : [result.data.aud]
  const uniqueAudiences = new Set(audiences)

  if (
    uniqueAudiences.size !== audiences.length ||
    !uniqueAudiences.has(policy.resourceAudience) ||
    audiences.some((audience) => !policy.allowedAudiences.has(audience))
  ) {
    throw new InvalidOAuthAccessTokenClaimsError(
      "The access token audience is not bound to the configured resources.",
    )
  }

  const scopes = result.data.scope.split(" ")
  const uniqueScopes = new Set(scopes)

  if (
    uniqueScopes.size !== scopes.length ||
    scopes.some((scope) => {
      const scopeAudience = policy.scopeAudienceByName.get(scope)
      return scopeAudience === undefined || !uniqueAudiences.has(scopeAudience)
    })
  ) {
    throw new InvalidOAuthAccessTokenClaimsError(
      "The access token scopes are not bound unambiguously to its audiences.",
    )
  }

  for (const tokenAudience of uniqueAudiences) {
    if (
      tokenAudience !== policy.resourceAudience &&
      !uniqueScopes.has(
        policy.additionalAudienceRequiredScopeByAudience.get(tokenAudience) ??
          "",
      )
    ) {
      throw new InvalidOAuthAccessTokenClaimsError(
        "The access token contains an audience without its activation scope.",
      )
    }
  }

  return { claims: result.data, scopes }
}

export async function verifyOAuthAccessToken(
  token: string,
  policy: OAuthAccessTokenVerificationPolicy,
): Promise<VerifiedOAuthAccessToken> {
  const validatedPolicy = validatePolicy(policy)
  const keyResolver: JWTVerifyGetKey = (protectedHeader, tokenToVerify) => {
    parseKeyId(protectedHeader.kid)
    return policy.keyResolver(protectedHeader, tokenToVerify)
  }
  const verification = await jwtVerify(
    token,
    keyResolver,
    validatedPolicy.verifyOptions,
  )
  const { claims, scopes } = parseVerifiedPayload(
    verification.payload,
    validatedPolicy,
  )
  const keyId = parseKeyId(verification.protectedHeader.kid)
  const signingAlgorithm = OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS.find(
    (algorithm) => algorithm === verification.protectedHeader.alg,
  )

  if (!signingAlgorithm) {
    throw new InvalidOAuthAccessTokenClaimsError(
      "The access token signing header is incomplete.",
    )
  }

  return {
    expiresAtSeconds: claims.exp,
    issuedAtSeconds: claims.iat,
    keyId,
    ...(claims.nbf === undefined ? {} : { notBeforeSeconds: claims.nbf }),
    principal: {
      authMethod: "oauth",
      clientId: claims.client_id,
      permissions: [],
      scopes,
      subject: claims.sub,
    },
    signingAlgorithm,
    tokenId: claims.jti,
  }
}

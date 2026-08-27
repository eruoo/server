import { importJWK, type JWK, type JWTVerifyGetKey } from "jose"

import {
  OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH,
  OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS,
} from "./oauth-access-token"

export const OAUTH_JWKS_NEGATIVE_CACHE_TTL_MS = 30_000
export const OAUTH_JWKS_POSITIVE_CACHE_TTL_MS = 5 * 60 * 1000

const verificationGracePeriodMs = 7 * 24 * 60 * 60 * 1000
const maximumPositiveEntries = 32
const maximumNegativeEntries = 256
const allowedAlgorithms = new Set<string>(OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS)

interface JwksRow {
  alg: string | null
  expiresAt: unknown
  publicKey: string
}

interface PositiveCacheEntry {
  key: CryptoKey
  validUntil: number
}

interface ResolverState {
  negative: Map<string, number>
  positive: Map<string, PositiveCacheEntry>
}

export class OAuthJwksDependencyError extends Error {
  override readonly name = "OAuthJwksDependencyError"
}

const resolverByDatabase = new WeakMap<object, JWTVerifyGetKey>()

function boundedSet<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maximumSize: number,
): void {
  map.delete(key)
  map.set(key, value)

  while (map.size > maximumSize) {
    const oldestKey = map.keys().next().value as Key | undefined
    if (oldestKey === undefined) break
    map.delete(oldestKey)
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number" || typeof value === "string"
        ? new Date(value).getTime()
        : Number.NaN

  return Number.isFinite(timestamp) ? timestamp : undefined
}

function parsePublicJwk(value: string, keyId: string, algorithm: string): JWK {
  let parsed: unknown

  try {
    parsed = JSON.parse(value)
  } catch {
    throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
  }

  const jwk = parsed as Record<string, unknown>
  const hasPrivateMaterial = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
    (field) => field in jwk,
  )
  const keyOperations = jwk["key_ops"]

  if (
    hasPrivateMaterial ||
    (jwk["alg"] !== undefined && jwk["alg"] !== algorithm) ||
    (jwk["kid"] !== undefined && jwk["kid"] !== keyId) ||
    (jwk["use"] !== undefined && jwk["use"] !== "sig") ||
    (keyOperations !== undefined &&
      (!Array.isArray(keyOperations) || !keyOperations.includes("verify")))
  ) {
    throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
  }

  const validKeyShape =
    (algorithm === "EdDSA" &&
      jwk["kty"] === "OKP" &&
      jwk["crv"] === "Ed25519" &&
      typeof jwk["x"] === "string") ||
    (algorithm === "RS256" &&
      jwk["kty"] === "RSA" &&
      typeof jwk["n"] === "string" &&
      typeof jwk["e"] === "string")

  if (!validKeyShape) {
    throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
  }

  return { ...jwk, alg: algorithm, kid: keyId, use: "sig" } as JWK
}

function readKeyIdentity(header: Parameters<JWTVerifyGetKey>[0]): {
  algorithm: string
  cacheKey: string
  keyId: string
} {
  const keyId = header.kid
  const algorithm = header.alg

  if (
    typeof keyId !== "string" ||
    keyId.length === 0 ||
    keyId.length > OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH ||
    keyId.trim() !== keyId ||
    typeof algorithm !== "string" ||
    !allowedAlgorithms.has(algorithm)
  ) {
    throw new Error("The OAuth access token signing key is invalid.")
  }

  return { algorithm, cacheKey: `${algorithm}:${keyId}`, keyId }
}

function createResolver(database: D1Database): JWTVerifyGetKey {
  const state: ResolverState = {
    negative: new Map(),
    positive: new Map(),
  }

  return async (header) => {
    const { algorithm, cacheKey, keyId } = readKeyIdentity(header)
    const now = Date.now()
    const positive = state.positive.get(cacheKey)

    if (positive && positive.validUntil >= now) return positive.key
    if (positive) state.positive.delete(cacheKey)

    const negativeUntil = state.negative.get(cacheKey)
    if (negativeUntil && negativeUntil > now) {
      throw new Error("The OAuth access token signing key is unknown.")
    }
    state.negative.delete(cacheKey)

    let row: JwksRow | null

    try {
      row = await database
        .prepare(
          `SELECT alg, expiresAt, publicKey
           FROM jwks
           WHERE id = ?1
           LIMIT 1`,
        )
        .bind(keyId)
        .first<JwksRow>()
    } catch (error) {
      throw new OAuthJwksDependencyError(
        error instanceof Error
          ? `The OAuth JWKS dependency failed: ${error.name}`
          : "The OAuth JWKS dependency failed.",
      )
    }

    const expiresAt = row ? parseTimestamp(row.expiresAt) : undefined
    if (
      row &&
      row.expiresAt !== null &&
      row.expiresAt !== undefined &&
      expiresAt === undefined
    ) {
      throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
    }
    const validUntil = expiresAt
      ? expiresAt + verificationGracePeriodMs
      : Number.POSITIVE_INFINITY

    if (!row || row.alg !== algorithm || validUntil < now) {
      boundedSet(
        state.negative,
        cacheKey,
        now + OAUTH_JWKS_NEGATIVE_CACHE_TTL_MS,
        maximumNegativeEntries,
      )
      throw new Error("The OAuth access token signing key is unknown.")
    }

    const jwk = parsePublicJwk(row.publicKey, keyId, algorithm)
    let imported: Awaited<ReturnType<typeof importJWK>>

    try {
      imported = await importJWK(jwk, algorithm)
    } catch {
      throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
    }

    if (imported instanceof Uint8Array) {
      throw new OAuthJwksDependencyError("The OAuth JWKS row is malformed.")
    }

    boundedSet(
      state.positive,
      cacheKey,
      {
        key: imported,
        validUntil: Math.min(
          validUntil,
          now + OAUTH_JWKS_POSITIVE_CACHE_TTL_MS,
        ),
      },
      maximumPositiveEntries,
    )
    return imported
  }
}

export function createD1OAuthJwksResolver(
  database: D1Database,
): JWTVerifyGetKey {
  const cached = resolverByDatabase.get(database)
  if (cached) return cached

  const resolver = createResolver(database)
  resolverByDatabase.set(database, resolver)
  return resolver
}

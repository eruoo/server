import { importJWK, type JWK, type JWTVerifyGetKey } from "jose"

import {
  OAUTH_ACCESS_TOKEN_MAX_KEY_ID_LENGTH,
  OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS,
} from "./access-token"

const OAUTH_JWKS_NEGATIVE_CACHE_TTL_MS = 30_000
export const OAUTH_JWKS_POSITIVE_CACHE_TTL_MS = 5 * 60 * 1000

const verificationGracePeriodMs = 7 * 24 * 60 * 60 * 1000
const maximumPositiveEntries = 32
const allowedAlgorithms = new Set<string>(OAUTH_ACCESS_TOKEN_SIGNING_ALGORITHMS)

interface JwksRow {
  id: string
  alg: string | null
  expiresAt: unknown
  publicKey: string
}

interface PositiveCacheEntry {
  key: CryptoKey
  validUntil: number
}

interface ResolverState {
  refreshAfter: number
  refreshFailed: boolean
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
    positive: new Map(),
    refreshAfter: 0,
    refreshFailed: false,
  }
  return async (header) => {
    const { cacheKey } = readKeyIdentity(header)
    const now = Date.now()
    const cached = state.positive.get(cacheKey)
    if (cached && cached.validUntil > now) return cached.key
    if (now < state.refreshAfter) {
      if (state.refreshFailed)
        throw new OAuthJwksDependencyError(
          "The OAuth JWKS dependency is unavailable.",
        )
      throw new Error("The OAuth access token signing key is unknown.")
    }
    // Reserve the issuer-wide cooldown before awaiting; no in-flight promise is shared.
    state.refreshAfter = now + OAUTH_JWKS_NEGATIVE_CACHE_TTL_MS
    state.refreshFailed = true
    try {
      const rows = await database
        .prepare(
          "SELECT id, alg, expiresAt, publicKey FROM jwks WHERE expiresAt IS NULL OR expiresAt > ? OR julianday(expiresAt) IS NULL ORDER BY createdAt DESC, id DESC LIMIT 33",
        )
        .bind(new Date(now - verificationGracePeriodMs).toISOString())
        .all<JwksRow>()
      if (rows.results.length > maximumPositiveEntries)
        throw new OAuthJwksDependencyError("Too many published signing keys.")
      const complete = new Map<string, PositiveCacheEntry>()
      for (const row of rows.results) {
        if (!row.alg || !allowedAlgorithms.has(row.alg)) continue
        const identity = readKeyIdentity({ kid: row.id, alg: row.alg })
        const expiresAt = parseTimestamp(row.expiresAt)
        if (row.expiresAt !== null && expiresAt === undefined)
          throw new OAuthJwksDependencyError(
            "Malformed signing key expiration.",
          )
        const graceUntil =
          expiresAt === undefined
            ? Infinity
            : expiresAt + verificationGracePeriodMs
        if (graceUntil <= now) continue
        const imported = await importJWK(
          parsePublicJwk(row.publicKey, row.id, row.alg),
          row.alg,
        )
        if (imported instanceof Uint8Array)
          throw new OAuthJwksDependencyError("Malformed signing key.")
        boundedSet(
          complete,
          identity.cacheKey,
          {
            key: imported,
            validUntil: Math.min(
              graceUntil,
              now + OAUTH_JWKS_POSITIVE_CACHE_TTL_MS,
            ),
          },
          maximumPositiveEntries,
        )
      }
      state.positive = complete
      state.refreshFailed = false
    } catch {
      throw new OAuthJwksDependencyError(
        "The OAuth JWKS dependency is unavailable.",
      )
    }
    const key = state.positive.get(cacheKey)
    if (!key) throw new Error("The OAuth access token signing key is unknown.")
    return key.key
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

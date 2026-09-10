import type { Jwk } from "better-auth/plugins/jwt"

// Both creation and rotation elect one live key per algorithm in D1.
// The plugin has already encrypted privateKey before calling this adapter.
export async function persistSigningKey(
  database: D1Database,
  candidate: Omit<Jwk, "id">,
): Promise<{ key: Jwk; created: boolean }> {
  const now = new Date().toISOString()
  const algorithm = candidate.alg ?? "EdDSA"
  const id = crypto.randomUUID()
  const liveKey =
    "COALESCE(alg, 'EdDSA') = ? AND (expiresAt IS NULL OR julianday(expiresAt) > julianday(?))"
  type StoredKey = Omit<Jwk, "createdAt" | "expiresAt" | "crv"> & {
    createdAt: string
    expiresAt: string | null
    crv: Jwk["crv"] | null
  }
  const results = await database.batch<StoredKey>([
    database
      .prepare(`INSERT INTO jwks (id, publicKey, privateKey, createdAt, expiresAt, alg, crv)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM jwks WHERE ${liveKey})`)
      .bind(
        id,
        candidate.publicKey,
        candidate.privateKey,
        now,
        candidate.expiresAt?.toISOString() ?? null,
        algorithm,
        candidate.crv ?? null,
        algorithm,
        now,
      ),
    database
      .prepare(
        `SELECT * FROM jwks WHERE ${liveKey} ORDER BY createdAt DESC, id DESC LIMIT 1`,
      )
      .bind(algorithm, now),
  ])
  const row = results[1]?.results[0]
  if (!row) throw new Error("Signing key could not be persisted")
  return {
    created: results[0]?.meta.changes === 1,
    key: {
      ...row,
      createdAt: new Date(row.createdAt),
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      crv: row.crv ?? undefined,
    },
  }
}

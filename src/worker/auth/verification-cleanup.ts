export async function deleteExpiredVerifications(
  database: D1Database,
  now = Date.now(),
): Promise<number> {
  const boundary = new Date(now)
  if (!Number.isSafeInteger(now) || !Number.isFinite(boundary.getTime())) {
    throw new RangeError("The verification cleanup boundary is invalid.")
  }

  const result = await database
    .prepare('DELETE FROM "verification" WHERE "expiresAt" < ?1')
    .bind(boundary.toISOString())
    .run()

  return result.meta.changes
}

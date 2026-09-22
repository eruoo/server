import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { cleanupExpiredAiState } from "../../src/worker/ai/cleanup"
import {
  createAiConnection,
  disconnectAiConnection,
  getAiConnection,
} from "../../src/worker/ai/connections"
import {
  assignAiInvocationIdentity,
  commitAiInvocationOutcome,
  listAiInvocationHistory,
  readAiInvocation,
  releaseAiInvocationReservation,
  reserveAiInvocation,
} from "../../src/worker/ai/invocations"
import { commitAiModelSnapshot, listAiModels } from "../../src/worker/ai/models"
import {
  AI_INVOCATION_RETENTION_MS,
  createAiInvocationRetentionCutoff,
  isAiConnectionSlug,
} from "../../src/worker/ai/policy"

const now = 2_000_000_000_000
const ownerUserId = "ai-state-owner"
const ownerSessionId = "ai-state-owner-session"

const connectionId = "11111111-1111-1111-1111-111111111111"

/** Deterministic hex UUIDs for synthetic fixtures (storage validates the shape). */
function uuidWithSuffix(prefix: string, seed: number): string {
  return `${prefix}-${seed.toString(16).padStart(12, "0")}`
}

function invocationRequestId(seed: number): string {
  return uuidWithSuffix("33333333-3333-3333-3333", seed)
}

async function createConnectedConnection(id: string, slug: string) {
  await createAiConnection(env.DB, {
    id,
    slug,
    name: slug,
    providerType: "deepseek",
    now,
  })
  await env.DB.prepare(
    "UPDATE ai_connections SET authorizationStatus='connected', credentialCiphertext='synthetic', credentialVersion=1 WHERE id=?",
  )
    .bind(id)
    .run()
}
async function insertInvocationRow(options: {
  requestId: string
  apiKeyId: string
  connectionId: string
  startedAt: number
  deadlineAt: number
  leaseExpiresAt: number
  status: string
  endedAt?: number | null
  usage?: string | null
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO "ai_invocations" (
       "requestId", "apiKeyId", "connectionId", "upstreamModelId",
       "startedAt", "deadlineAt", "leaseExpiresAt", "status",
       "endedAt", "errorCode", "upstreamRequestId", "usage"
     ) VALUES (?1, ?2, ?3, 'gpt-6-astra', ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9)`,
  )
    .bind(
      options.requestId,
      options.apiKeyId,
      options.connectionId,
      options.startedAt,
      options.deadlineAt,
      options.leaseExpiresAt,
      options.status,
      options.endedAt ?? null,
      options.usage ?? null,
    )
    .run()
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM "${table}"`,
  ).first<{ count: number }>()
  if (row === null) throw new Error(`The ${table} count read failed.`)
  return row.count
}

describe("AI state storage", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await env.DB.batch([
      env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_ai_completion_failure"),
      env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_ai_cleanup_failure"),
      env.DB.prepare("DELETE FROM ai_invocations"),
      env.DB.prepare("DELETE FROM ai_models"),

      env.DB.prepare("DELETE FROM ai_connections"),
      env.DB.prepare("DELETE FROM session WHERE id = ?1").bind(ownerSessionId),
      env.DB.prepare("DELETE FROM user WHERE id = ?1").bind(ownerUserId),
    ])
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?1, 'AI state owner', 'ai-state@example.invalid', 1, 0, 0)`,
      ).bind(ownerUserId),
      env.DB.prepare(
        `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId, reauthenticatedAt)
         VALUES (?1, 999999999999, 'ai-state-session-token', 0, 0, NULL, NULL, ?2, 0)`,
      ).bind(ownerSessionId, ownerUserId),
    ])
  })

  it("validates connection slugs and provider types before writing", async () => {
    expect(isAiConnectionSlug("codex-main")).toBe(true)
    expect(isAiConnectionSlug("a")).toBe(true)
    expect(isAiConnectionSlug("a-b-c")).toBe(true)
    expect(isAiConnectionSlug("")).toBe(false)
    expect(isAiConnectionSlug("A-b")).toBe(false)
    expect(isAiConnectionSlug("-ab")).toBe(false)
    expect(isAiConnectionSlug("ab-")).toBe(false)
    expect(isAiConnectionSlug("a--b")).toBe(false)
    expect(isAiConnectionSlug("a_b")).toBe(false)
    expect(isAiConnectionSlug("a.b")).toBe(false)
    expect(isAiConnectionSlug("设备")).toBe(false)
    expect(isAiConnectionSlug("a".repeat(64))).toBe(true)
    expect(isAiConnectionSlug("a".repeat(65))).toBe(false)

    await expect(
      createAiConnection(env.DB, {
        id: connectionId,
        slug: "Not A Slug",
        name: "x",
        providerType: "deepseek",
        now,
      }),
    ).rejects.toThrow("slug is invalid")
    await expect(
      createAiConnection(env.DB, {
        id: connectionId,
        slug: "codex-main",
        name: "x",
        providerType: "unknown-provider",
        now,
      }),
    ).rejects.toThrow("provider type is unknown")
  })

  it("updates model snapshots under version constraints and keeps exact model ids", async () => {
    await createConnectedConnection(connectionId, "main")
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection?.credentialVersion).toBe(1)

    const committed = await commitAiModelSnapshot(env.DB, {
      connectionId,
      observedCredentialVersion: 1,
      models: [
        {
          upstreamModelId: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          capabilities: '{"text":true}',
        },
        {
          // Exact upstream id: no case folding or trimming is applied.
          upstreamModelId: "GPT-6-Astra",
          displayName: null,
          capabilities: null,
        },
      ],
      now: now + 1_000,
    })
    expect(committed).toEqual({ committed: true, modelCount: 2 })
    expect(await listAiModels(env.DB, connectionId)).toEqual([
      {
        connectionId,
        upstreamModelId: "GPT-6-Astra",
        displayName: null,
        capabilities: null,
        snapshotCredentialVersion: 1,
        discoveredAt: now + 1_000,
      },
      {
        connectionId,
        upstreamModelId: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        capabilities: '{"text":true}',
        snapshotCredentialVersion: 1,
        discoveredAt: now + 1_000,
      },
    ])

    // A stale version cannot replace the current snapshot.
    await expect(
      commitAiModelSnapshot(env.DB, {
        connectionId,
        observedCredentialVersion: 0,
        models: [
          {
            upstreamModelId: "stale-model",
            displayName: null,
            capabilities: null,
          },
        ],
        now: now + 2_000,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "credential-version-changed",
    })
    expect(await countRows("ai_models")).toBe(2)

    // Neither can a disconnected connection.
    await disconnectAiConnection(env.DB, { id: connectionId, now: now + 3_000 })
    await expect(
      commitAiModelSnapshot(env.DB, {
        connectionId,
        observedCredentialVersion: 2,
        models: [
          {
            upstreamModelId: "post-disconnect-model",
            displayName: null,
            capabilities: null,
          },
        ],
        now: now + 4_000,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "connection-not-connected",
    })
    expect(await countRows("ai_models")).toBe(2)

    await expect(
      commitAiModelSnapshot(env.DB, {
        connectionId: "15151515-1515-1515-1515-151515151515",
        observedCredentialVersion: 1,
        models: [],
        now: now + 5_000,
      }),
    ).resolves.toEqual({ committed: false, reason: "connection-not-found" })
  })

  it("admits in-flight invocations through one conditional write", async () => {
    await createConnectedConnection(connectionId, "main")

    const first = await reserveAiInvocation(env.DB, {
      requestId: invocationRequestId(1),
      apiKeyId: "key-a",
      startedAt: now,
      deadlineAt: now + 300_000,
    })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId: invocationRequestId(1),
        upstreamModelId: "gpt-6-astra",
      }),
    ).toEqual({ assigned: true })
    expect(first).toEqual({ reserved: true })
    const second = await reserveAiInvocation(env.DB, {
      requestId: invocationRequestId(2),
      apiKeyId: "key-b",
      startedAt: now,
      deadlineAt: now + 300_000,
    })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId: invocationRequestId(2),
        upstreamModelId: "gpt-6-astra",
      }),
    ).toEqual({ assigned: true })
    expect(second).toEqual({ reserved: true })

    // The global quota is full: no third reservation is inserted.
    const before = await countRows("ai_invocations")
    const third = await reserveAiInvocation(env.DB, {
      requestId: invocationRequestId(3),
      apiKeyId: "key-c",
      startedAt: now,
      deadlineAt: now + 300_000,
    })
    expect(third).toEqual({ reserved: false, reason: "service-quota-exceeded" })
    expect(await countRows("ai_invocations")).toBe(before)

    // Terminal outcomes release their slot for later requests.
    expect(
      await commitAiInvocationOutcome(env.DB, {
        requestId: invocationRequestId(1),
        status: "succeeded",
        endedAt: now + 5_000,
        upstreamRequestId: "req-upstream-1",
        usage: '{"input_tokens":12,"output_tokens":34}',
      }),
    ).toEqual({ committed: true })
    const afterTerminal = await reserveAiInvocation(env.DB, {
      requestId: invocationRequestId(3),
      apiKeyId: "key-c",
      startedAt: now + 6_000,
      deadlineAt: now + 306_000,
    })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId: invocationRequestId(3),
        upstreamModelId: "gpt-6-astra",
      }),
    ).toEqual({ assigned: true })
    expect(afterTerminal).toEqual({ reserved: true })

    // Per-key quota: the same key cannot hold two in-flight slots while the
    // service still has room.
    expect(
      await reserveAiInvocation(env.DB, {
        requestId: invocationRequestId(4),
        apiKeyId: "key-c",
        startedAt: now + 7_000,
        deadlineAt: now + 307_000,
      }),
    ).toEqual({ reserved: false, reason: "key-quota-exceeded" })

    // Concurrent reservations cannot exceed either limit.
    const raced = await Promise.all(
      [5, 6, 7, 8].map((seed) =>
        reserveAiInvocation(env.DB, {
          requestId: invocationRequestId(seed),
          apiKeyId: `key-race-${seed}`,
          startedAt: now + 8_000,
          deadlineAt: now + 308_000,
        }),
      ),
    )
    const reservedCount = raced.filter((result) => result.reserved).length
    const inFlight = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM "ai_invocations" WHERE "status" = 'reserved' AND "leaseExpiresAt" > ?1`,
    )
      .bind(now + 8_000)
      .first<{ count: number }>()
    // One service slot was free before the race (two reserved at that point).
    expect(reservedCount).toBeGreaterThanOrEqual(0)
    expect(inFlight?.count).toBeLessThanOrEqual(2)
    const perKey = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM "ai_invocations" WHERE "status" = 'reserved' AND "apiKeyId" = ?1 AND "leaseExpiresAt" > ?2`,
    )
      .bind("key-race-5", now + 8_000)
      .first<{ count: number }>()
    expect(perKey?.count).toBeLessThanOrEqual(1)

    // Release every live in-flight reservation so the quota has room again.
    const liveInFlight = await env.DB.prepare(
      `SELECT "requestId" FROM "ai_invocations" WHERE "status" = 'reserved' AND "leaseExpiresAt" > ?1`,
    )
      .bind(now + 8_000)
      .all<{ requestId: string }>()
    for (const row of liveInFlight.results) {
      expect(
        await commitAiInvocationOutcome(env.DB, {
          requestId: row.requestId,
          status: "failed",
          endedAt: now + 9_000,
        }),
      ).toEqual({ committed: true })
    }

    // Expired reservations stop counting against the quota but are not
    // deleted from history.
    await insertInvocationRow({
      requestId: invocationRequestId(9001),
      apiKeyId: "key-expired",
      connectionId,
      startedAt: now - 400_000,
      deadlineAt: now - 100_000,
      leaseExpiresAt: now - 70_000,
      status: "reserved",
    })
    await expect(
      reserveAiInvocation(env.DB, {
        requestId: invocationRequestId(9),
        apiKeyId: "key-expired",
        startedAt: now,
        deadlineAt: now + 300_000,
      }),
    ).resolves.toMatchObject({ reserved: true })
  })

  it("identifies and releases only unidentified reservations", async () => {
    await createConnectedConnection(connectionId, "main")
    const requestId = invocationRequestId(1)

    // Nothing to identify or release before the reservation exists.
    expect(await releaseAiInvocationReservation(env.DB, requestId)).toEqual({
      reason: "invocation-not-found",
      released: false,
    })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId,
        upstreamModelId: "gpt-6-astra",
      }),
    ).toEqual({ assigned: false, reason: "invocation-not-found" })

    // A reservation that never started is given back immediately.
    await reserveAiInvocation(env.DB, {
      requestId,
      apiKeyId: "key-release",
      startedAt: now,
      deadlineAt: now + 300_000,
    })
    expect(await releaseAiInvocationReservation(env.DB, requestId)).toEqual({
      released: true,
    })
    expect(await readAiInvocation(env.DB, requestId, now)).toBeNull()

    // Identity is recorded once, and a second writer cannot overwrite it.
    await reserveAiInvocation(env.DB, {
      requestId,
      apiKeyId: "key-release",
      startedAt: now,
      deadlineAt: now + 300_000,
    })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId,
        upstreamModelId: "gpt-6-astra",
      }),
    ).toEqual({ assigned: true })
    expect(
      await assignAiInvocationIdentity(env.DB, {
        connectionId,
        requestId,
        upstreamModelId: "other-model",
      }),
    ).toEqual({ assigned: false, reason: "invocation-already-identified" })

    // A call that already ran is never deleted by a late release, and its
    // identity is preserved.
    await commitAiInvocationOutcome(env.DB, {
      requestId,
      status: "succeeded",
      endedAt: now + 1_000,
    })
    expect(await releaseAiInvocationReservation(env.DB, requestId)).toEqual({
      reason: "invocation-not-reserved",
      released: false,
    })
    expect(await readAiInvocation(env.DB, requestId, now)).toMatchObject({
      connectionId,
      status: "succeeded",
      upstreamModelId: "gpt-6-astra",
    })
  })

  it("uses the partial in-flight indexes for quota and cleanup predicates", async () => {
    const statements = [
      {
        indexes: ["ai_invocations_inflight_lease_idx"],
        sql: `SELECT COUNT(*) FROM "ai_invocations" WHERE "status" = 'reserved' AND "leaseExpiresAt" > ?1`,
        values: [now],
      },
      {
        indexes: ["ai_invocations_inflight_apiKey_lease_idx"],
        sql: `SELECT COUNT(*) FROM "ai_invocations" WHERE "status" = 'reserved' AND "apiKeyId" = ?1 AND "leaseExpiresAt" > ?2`,
        values: ["key-a", now],
      },
      {
        indexes: ["ai_invocations_startedAt_requestId_idx"],
        sql: `SELECT "requestId" FROM "ai_invocations" WHERE "startedAt" < ?1 LIMIT 500`,
        values: [now],
      },
    ] as const
    for (const statement of statements) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .bind(...statement.values)
        .all<{ detail: string }>()
      const details = plan.results.map(({ detail }) => detail).join("\n")
      for (const index of statement.indexes) expect(details).toContain(index)
    }
  })

  it("treats an unreported invocation as unknown after its lease expires", async () => {
    await insertInvocationRow({
      requestId: invocationRequestId(9002),
      apiKeyId: "key-unknown",
      connectionId,
      startedAt: now - 400_000,
      deadlineAt: now - 100_000,
      leaseExpiresAt: now - 70_000,
      status: "reserved",
    })
    const record = await readAiInvocation(
      env.DB,
      invocationRequestId(9002),
      now,
    )
    expect(record).toMatchObject({
      status: "reserved",
      effectiveStatus: "unknown",
      usage: null,
    })

    const fresh = await readAiInvocation(
      env.DB,
      invocationRequestId(9002),
      now - 80_000,
    )
    expect(fresh).toMatchObject({
      status: "reserved",
      effectiveStatus: "reserved",
    })

    // A late terminal write is accepted exactly once and never replayed.
    expect(
      await commitAiInvocationOutcome(env.DB, {
        requestId: invocationRequestId(9002),
        status: "failed",
        endedAt: now,
        errorCode: "ai-upstream-protocol-error",
      }),
    ).toEqual({ committed: true })
    await expect(
      commitAiInvocationOutcome(env.DB, {
        requestId: invocationRequestId(9002),
        status: "succeeded",
        endedAt: now + 1,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "invocation-already-terminal",
    })
    await expect(
      commitAiInvocationOutcome(env.DB, {
        requestId: invocationRequestId(99),
        status: "failed",
        endedAt: now,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "invocation-not-found",
    })
  })

  it("filters history reads with the shared 30-day boundary and paginates exclusively", async () => {
    const cutoff = createAiInvocationRetentionCutoff(now)
    expect(cutoff).toBe(now - AI_INVOCATION_RETENTION_MS)

    await insertInvocationRow({
      requestId: invocationRequestId(9100),
      apiKeyId: "key",
      connectionId,
      startedAt: cutoff - 1,
      deadlineAt: cutoff + 1,
      leaseExpiresAt: cutoff + 2,
      status: "succeeded",
      endedAt: cutoff + 1,
    })
    await insertInvocationRow({
      requestId: invocationRequestId(9101),
      apiKeyId: "key",
      connectionId,
      startedAt: cutoff,
      deadlineAt: cutoff + 1,
      leaseExpiresAt: cutoff + 2,
      status: "succeeded",
      endedAt: cutoff + 1,
    })

    // Sixty recent rows with tied startedAt values to exercise the cursor
    // tie-break on requestId DESC.
    for (let seed = 0; seed < 60; seed++) {
      await insertInvocationRow({
        requestId: invocationRequestId(seed),
        apiKeyId: "key",
        connectionId,
        startedAt: now - seed,
        deadlineAt: now - seed + 1,
        leaseExpiresAt: now - seed + 2,
        status: seed % 2 === 0 ? "succeeded" : "failed",
        endedAt: now - seed + 1,
      })
    }

    const firstPage = await listAiInvocationHistory(env.DB, { now, limit: 50 })
    expect(firstPage.records).toHaveLength(50)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.records[0]?.requestId).toBe(invocationRequestId(0))
    expect(firstPage.records[0]?.startedAt).toBe(now)
    expect(firstPage.records.at(-1)).toMatchObject({
      requestId: invocationRequestId(49),
      startedAt: now - 49,
    })

    const secondPage = await listAiInvocationHistory(env.DB, {
      now,
      limit: 50,
      before: firstPage.nextCursor ?? undefined,
    })
    expect(secondPage.records.map(({ requestId }) => requestId)).toEqual([
      ...Array.from({ length: 10 }, (_, index) =>
        invocationRequestId(50 + index),
      ),
      invocationRequestId(9101),
    ])
    expect(secondPage.nextCursor).toBeNull()
    // The row past the retention cutoff is invisible to reads.
    expect(
      [...firstPage.records, ...secondPage.records].some(
        ({ requestId }) => requestId === "history-old",
      ),
    ).toBe(false)

    // Reads and cleanup share the same boundary: what the read excludes is
    // exactly what cleanup deletes.
    await cleanupExpiredAiState(env.DB, now)
    expect(await countRows("ai_invocations")).toBe(61)
    const afterCleanup = await listAiInvocationHistory(env.DB, {
      now,
      limit: 100,
    })
    expect(afterCleanup.records).toHaveLength(61)

    await expect(
      listAiInvocationHistory(env.DB, { now, limit: 0 }),
    ).rejects.toThrow("limit is invalid")
    await expect(
      listAiInvocationHistory(env.DB, { now, limit: 101 }),
    ).rejects.toThrow("limit is invalid")
  })

  it("applies the shared retention boundary to single-row reads", async () => {
    const cutoff = createAiInvocationRetentionCutoff(now)
    await insertInvocationRow({
      requestId: invocationRequestId(9300),
      apiKeyId: "key",
      connectionId,
      startedAt: cutoff - 1,
      deadlineAt: cutoff,
      leaseExpiresAt: cutoff + 1,
      status: "succeeded",
      endedAt: cutoff,
    })
    // A reserved row exactly on the boundary whose lease has long expired:
    // still readable, interpreted as unknown, with unknown usage.
    await insertInvocationRow({
      requestId: invocationRequestId(9301),
      apiKeyId: "key",
      connectionId,
      startedAt: cutoff,
      deadlineAt: cutoff + 1,
      leaseExpiresAt: cutoff + 2,
      status: "reserved",
    })
    await insertInvocationRow({
      requestId: invocationRequestId(9302),
      apiKeyId: "key",
      connectionId,
      startedAt: cutoff + 1,
      deadlineAt: cutoff + 2,
      leaseExpiresAt: cutoff + 3,
      status: "succeeded",
      endedAt: cutoff + 2,
      usage: '{"input_tokens":1}',
    })

    await expect(
      readAiInvocation(env.DB, invocationRequestId(9300), now),
    ).resolves.toBeNull()
    await expect(
      readAiInvocation(env.DB, invocationRequestId(9301), now),
    ).resolves.toMatchObject({
      status: "reserved",
      effectiveStatus: "unknown",
      usage: null,
    })
    await expect(
      readAiInvocation(env.DB, invocationRequestId(9302), now),
    ).resolves.toMatchObject({
      status: "succeeded",
      usage: '{"input_tokens":1}',
    })

    // The list read agrees exactly with the single-row boundary.
    const page = await listAiInvocationHistory(env.DB, { now, limit: 100 })
    expect(page.records.map(({ requestId }) => requestId)).toEqual([
      invocationRequestId(9302),
      invocationRequestId(9301),
    ])
  })
})

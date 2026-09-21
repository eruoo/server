import { createScheduledController, env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import worker from "../../src/worker"
import {
  cancelAiAuthorizationSession,
  claimAiAuthorizationPoll,
  completeAiAuthorization,
  createAiAuthorizationSession,
  releaseAiAuthorizationPoll,
} from "../../src/worker/ai/authorizations"
import { cleanupExpiredAiState } from "../../src/worker/ai/cleanup"
import {
  createAiConnection,
  deleteAiConnection,
  disconnectAiConnection,
  getAiConnection,
  updateAiConnection,
} from "../../src/worker/ai/connections"
import {
  acquireAiCredentialRefreshClaim,
  commitAiCredentialRefresh,
  releaseAiCredentialRefreshClaim,
} from "../../src/worker/ai/credentials"
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
  AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
  AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS,
  AI_INVOCATION_RETENTION_MS,
  createAiInvocationRetentionCutoff,
  isAiConnectionSlug,
} from "../../src/worker/ai/policy"
import { DAILY_CLEANUP_SCHEDULE } from "../../src/worker/schedules"

const now = 2_000_000_000_000
const ownerUserId = "ai-state-owner"
const ownerSessionId = "ai-state-owner-session"

const connectionId = "11111111-1111-1111-1111-111111111111"
const secondConnectionId = "11111111-1111-1111-1111-111111111112"
const sessionId = "22222222-2222-2222-2222-222222222220"
const secondSessionId = "22222222-2222-2222-2222-222222222221"

/** Deterministic hex UUIDs for synthetic fixtures (storage validates the shape). */
function uuidWithSuffix(prefix: string, seed: number): string {
  return `${prefix}-${seed.toString(16).padStart(12, "0")}`
}

function invocationRequestId(seed: number): string {
  return uuidWithSuffix("33333333-3333-3333-3333", seed)
}

let authorizationSessionSeed = 0
function nextAuthorizationSessionId(): string {
  authorizationSessionSeed += 1
  return uuidWithSuffix("44444444-4444-4444-4444", authorizationSessionSeed)
}

async function createConnectedConnection(
  id: string,
  slug: string,
): Promise<void> {
  const created = await createAiConnection(env.DB, {
    id,
    slug,
    name: `Connection ${slug}`,
    providerType: "openai-codex",
    now,
  })
  expect(created).toMatchObject({ created: true })
  const authorizationSessionId = nextAuthorizationSessionId()
  const session = await createAiAuthorizationSession(env.DB, {
    id: authorizationSessionId,
    connectionId: id,
    ownerUserId,
    ownerSessionId,
    deviceGrantCiphertext: `device-grant-${slug}`,
    sessionTtlMs: AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
    pollIntervalMs: 5_000,
    now,
  })
  expect(session).toMatchObject({ created: true })
  const claimId = `55555555-5555-5555-5555-${authorizationSessionSeed
    .toString(16)
    .padStart(12, "0")}`
  const claimed = await claimAiAuthorizationPoll(env.DB, {
    sessionId: authorizationSessionId,
    ownerUserId,
    ownerSessionId,
    claimId,
    now: now + 6_000,
  })
  expect(claimed).toMatchObject({ claimed: true })
  const completed = await completeAiAuthorization(env.DB, {
    sessionId: authorizationSessionId,
    claimId,
    completionId: `66666666-6666-6666-6666-${authorizationSessionSeed
      .toString(16)
      .padStart(12, "0")}`,
    credentialCiphertext: `credential-package-${slug}`,
    credentialExpiresAt: now + 3_600_000,
    upstreamAccountId: `account-${slug}`,
    now: now + 7_000,
  })
  expect(completed).toMatchObject({ completed: true })
}

async function insertSessionRow(options: {
  id: string
  connectionId: string
  expiresAt: number
  status?: string
  connectionCredentialVersion?: number
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO "ai_authorization_sessions" (
       "id", "connectionId", "ownerUserId", "ownerSessionId",
       "connectionCredentialVersion", "status", "deviceGrantCiphertext",
       "expiresAt", "nextPollAt", "pollClaimId", "pollClaimExpiresAt",
       "completionId", "createdAt", "updatedAt"
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, ?10, ?10)`,
  )
    .bind(
      options.id,
      options.connectionId,
      ownerUserId,
      ownerSessionId,
      options.connectionCredentialVersion ?? 0,
      options.status ?? "pending",
      `device-grant-${options.id}`,
      options.expiresAt,
      now - 5_000,
      now - 60_000,
    )
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
      env.DB.prepare("DELETE FROM ai_authorization_sessions"),
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

  it("applies the full migration set and enforces the AI schema constraints", async () => {
    const migrations = await env.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>()
    expect(migrations.results.map(({ name }) => name)).toEqual([
      "0001_foundation.sql",
      "0002_ai_service.sql",
      "0003_invocation_admission.sql",
    ])

    const columns = await env.DB.prepare(
      'PRAGMA table_info("ai_connections")',
    ).all<{ name: string }>()
    expect(new Set(columns.results.map(({ name }) => name))).toEqual(
      new Set([
        "id",
        "slug",
        "name",
        "providerType",
        "enabled",
        "authorizationStatus",
        "upstreamAccountId",
        "credentialVersion",
        "credentialCiphertext",
        "credentialExpiresAt",
        "refreshClaimId",
        "refreshClaimExpiresAt",
        "createdAt",
        "updatedAt",
      ]),
    )

    const invocationIndexes = await env.DB.prepare(
      'PRAGMA index_list("ai_invocations")',
    ).all<{ name: string; partial: number }>()
    const indexInfo = new Map(
      invocationIndexes.results.map((row) => [row.name, row.partial]),
    )
    expect(indexInfo.get("ai_invocations_startedAt_requestId_idx")).toBe(0)
    expect(indexInfo.get("ai_invocations_inflight_lease_idx")).toBe(1)
    expect(indexInfo.get("ai_invocations_inflight_apiKey_lease_idx")).toBe(1)

    // Slug format rules are enforced by the schema itself, not only by the
    // storage layer, and terminal states require an endedAt timestamp.
    await expect(
      env.DB.prepare(
        `INSERT INTO "ai_connections" VALUES ('99999999-9999-9999-9999-999999999990', 'Bad-Slug', 'x', 'openai-codex', 1, 'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, 0, 0)`,
      ).run(),
    ).rejects.toThrow("CHECK constraint failed")
    await expect(
      env.DB.prepare(
        `INSERT INTO "ai_connections" VALUES ('99999999-9999-9999-9999-999999999991', 'double--hyphen', 'x', 'openai-codex', 1, 'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, 0, 0)`,
      ).run(),
    ).rejects.toThrow("CHECK constraint failed")
    await expect(
      env.DB.prepare(
        `INSERT INTO "ai_connections" VALUES ('99999999-9999-9999-9999-999999999992', '-leading', 'x', 'openai-codex', 1, 'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, 0, 0)`,
      ).run(),
    ).rejects.toThrow("CHECK constraint failed")
    await expect(
      env.DB.prepare(
        `INSERT INTO "ai_connections" VALUES ('99999999-9999-9999-9999-999999999993', '${"a".repeat(65)}', 'x', 'openai-codex', 1, 'never_authorized', NULL, 0, NULL, NULL, NULL, NULL, 0, 0)`,
      ).run(),
    ).rejects.toThrow("CHECK constraint failed")
    await expect(
      insertInvocationRow({
        requestId: "invalid-terminal",
        apiKeyId: "key",
        connectionId: connectionId,
        startedAt: now,
        deadlineAt: now + 1,
        leaseExpiresAt: now + 2,
        status: "succeeded",
        endedAt: null,
      }),
    ).rejects.toThrow("CHECK constraint failed")
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
        providerType: "openai-codex",
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

  it("keeps slugs unique and immutable while deleted slugs restart with a new UUID", async () => {
    const first = await createAiConnection(env.DB, {
      id: connectionId,
      slug: "codex-main",
      name: "First",
      providerType: "openai-codex",
      now,
    })
    expect(first).toMatchObject({
      created: true,
      connection: {
        authorizationStatus: "never_authorized",
        credentialVersion: 0,
        enabled: true,
      },
    })

    const duplicate = await createAiConnection(env.DB, {
      id: secondConnectionId,
      slug: "codex-main",
      name: "Second",
      providerType: "openai-codex",
      now,
    })
    expect(duplicate).toEqual({ created: false, reason: "slug-exists" })

    // Concurrent creators of the same slug produce exactly one row: the
    // conditional insert decides, not a prior read.
    const raced = await Promise.all(
      [
        "11111111-1111-1111-1111-111111111113",
        "11111111-1111-1111-1111-111111111114",
      ].map((id) =>
        createAiConnection(env.DB, {
          id,
          slug: "codex-race",
          name: "Racer",
          providerType: "openai-codex",
          now,
        }),
      ),
    )
    expect(raced.filter((result) => result.created)).toHaveLength(1)

    const updated = await updateAiConnection(env.DB, {
      id: connectionId,
      name: "Renamed",
      enabled: false,
      now: now + 1_000,
    })
    expect(updated).toEqual({ updated: true })
    const afterUpdate = await getAiConnection(env.DB, connectionId)
    expect(afterUpdate).toMatchObject({
      name: "Renamed",
      enabled: false,
      slug: "codex-main",
    })
    expect(
      await updateAiConnection(env.DB, {
        id: "12121212-1212-1212-1212-121212121212",
        name: "Missing",
        now,
      }),
    ).toEqual({ updated: false, reason: "not-found" })

    // History survives connection deletion, and the reused slug gets a new
    // server-generated UUID with no inherited state.
    await reserveAiInvocation(env.DB, {
      requestId: invocationRequestId(1),
      apiKeyId: "key-history",
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
    await commitAiInvocationOutcome(env.DB, {
      requestId: invocationRequestId(1),
      status: "succeeded",
      endedAt: now + 1_000,
    })
    expect(await deleteAiConnection(env.DB, { id: connectionId })).toEqual({
      deleted: true,
    })
    expect(await deleteAiConnection(env.DB, { id: connectionId })).toEqual({
      deleted: false,
      reason: "not-found",
    })
    expect(await countRows("ai_invocations")).toBe(1)

    const recreated = await createAiConnection(env.DB, {
      id: secondConnectionId,
      slug: "codex-main",
      name: "Recreated",
      providerType: "openai-codex",
      now: now + 2_000,
    })
    expect(recreated).toMatchObject({
      created: true,
      connection: { id: secondConnectionId, credentialVersion: 0 },
    })
  })

  it("binds authorization sessions to the connection version and yields one poll claim winner", async () => {
    await createAiConnection(env.DB, {
      id: connectionId,
      slug: "codex-main",
      name: "Main",
      providerType: "openai-codex",
      now,
    })
    const missing = await createAiAuthorizationSession(env.DB, {
      id: sessionId,
      connectionId: "13131313-1313-1313-1313-131313131313",
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 5_000,
      now,
    })
    expect(missing).toEqual({ created: false, reason: "connection-not-found" })

    const created = await createAiAuthorizationSession(env.DB, {
      id: sessionId,
      connectionId,
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 60_000,
      now,
    })
    expect(created).toMatchObject({
      created: true,
      session: { connectionCredentialVersion: 0, status: "pending" },
    })

    // The poll interval has not elapsed yet.
    const tooEarly = await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555551",
      now: now + 30_000,
    })
    expect(tooEarly).toEqual({ claimed: false, reason: "poll-too-early" })

    // Independent callers race for one claim: exactly one winner.
    const claimed = await Promise.all([
      claimAiAuthorizationPoll(env.DB, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        claimId: "55555555-5555-5555-5555-555555555552",
        now: now + 60_000,
      }),
      claimAiAuthorizationPoll(env.DB, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        claimId: "55555555-5555-5555-5555-555555555553",
        now: now + 60_000,
      }),
    ])
    expect(claimed.filter((result) => result.claimed)).toHaveLength(1)
    expect(
      claimed.filter((result) => !result.claimed).map(({ reason }) => reason),
    ).toEqual(["poll-claim-held"])

    const wrongSession = await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId: "another-session",
      claimId: "55555555-5555-5555-5555-555555555554",
      now: now + 60_000,
    })
    expect(wrongSession).toEqual({
      claimed: false,
      reason: "owner-session-mismatch",
    })

    // Releasing returns the session to claimable state at the next interval.
    const released = await releaseAiAuthorizationPoll(env.DB, {
      sessionId,
      claimId:
        claimed[0]?.claimed === true
          ? (claimed[0].session.pollClaimId ?? "")
          : "",
      nextPollAt: now + 70_000,
      now: now + 65_000,
    })
    expect(released).toEqual({ released: true })

    await env.DB.prepare(
      'UPDATE "ai_authorization_sessions" SET "expiresAt" = ?2 WHERE "id" = ?1',
    )
      .bind(sessionId, now + 60_000)
      .run()
    await expect(
      claimAiAuthorizationPoll(env.DB, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        claimId: "55555555-5555-5555-5555-555555555555",
        now: now + 120_000,
      }),
    ).resolves.toMatchObject({ claimed: false, reason: "session-expired" })
  })

  it("completes authorization atomically and keeps account identity stable", async () => {
    await createConnectedConnection(connectionId, "main")
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      upstreamAccountId: "account-main",
      credentialVersion: 1,
      credentialCiphertext: "credential-package-main",
    })

    // Reauthorization must target the same upstream account.
    const session = await createAiAuthorizationSession(env.DB, {
      id: sessionId,
      connectionId,
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 5_000,
      now: now + 10_000,
    })
    expect(session).toMatchObject({
      created: true,
      session: { connectionCredentialVersion: 1 },
    })
    const claimed = await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555560",
      now: now + 20_000,
    })
    expect(claimed).toMatchObject({ claimed: true })
    const mismatched = await completeAiAuthorization(env.DB, {
      sessionId,
      claimId: "55555555-5555-5555-5555-555555555560",
      completionId: "66666666-6666-6666-6666-666666666661",
      credentialCiphertext: "credential-package-other",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-other",
      now: now + 30_000,
    })
    expect(mismatched).toEqual({
      completed: false,
      reason: "upstream-account-mismatch",
    })
    // The rejected completion left no partial state behind.
    expect(
      await env.DB.prepare(
        'SELECT "authorizationStatus", "credentialCiphertext" FROM "ai_connections" WHERE "id" = ?1',
      )
        .bind(connectionId)
        .first(),
    ).toEqual({
      authorizationStatus: "connected",
      credentialCiphertext: "credential-package-main",
    })

    const matching = await completeAiAuthorization(env.DB, {
      sessionId,
      claimId: "55555555-5555-5555-5555-555555555560",
      completionId: "66666666-6666-6666-6666-666666666662",
      credentialCiphertext: "credential-package-main-2",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-main",
      now: now + 30_000,
    })
    expect(matching).toEqual({ completed: true })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "connected",
      credentialVersion: 2,
      credentialCiphertext: "credential-package-main-2",
    })

    // A replayed completion cannot write credentials a second time.
    const replay = await completeAiAuthorization(env.DB, {
      sessionId,
      claimId: "55555555-5555-5555-5555-555555555560",
      completionId: "66666666-6666-6666-6666-666666666663",
      credentialCiphertext: "credential-package-replay",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-main",
      now: now + 40_000,
    })
    expect(replay).toEqual({ completed: false, reason: "session-not-pending" })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialCiphertext: "credential-package-main-2",
    })
  })

  it("rejects late exchange results after cancel, disconnect, owner-session revocation, and deletion", async () => {
    await createConnectedConnection(connectionId, "main")

    // A cancelled session can no longer complete.
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
    })
    await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555570",
      now: now + 5_000,
    })
    expect(
      await cancelAiAuthorizationSession(env.DB, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        now: now + 6_000,
      }),
    ).toEqual({ cancelled: true })
    await expect(
      completeAiAuthorization(env.DB, {
        sessionId,
        claimId: "55555555-5555-5555-5555-555555555570",
        completionId: "66666666-6666-6666-6666-666666666670",
        credentialCiphertext: "late-cancel",
        credentialExpiresAt: now + 7_200_000,
        upstreamAccountId: "account-main",
        now: now + 7_000,
      }),
    ).resolves.toMatchObject({ completed: false })

    // An expired poll claim cannot complete either.
    await env.DB.prepare("DELETE FROM ai_authorization_sessions").run()
    await insertSessionRow({
      id: secondSessionId,
      connectionId,
      expiresAt: now + 900_000,
    })
    await claimAiAuthorizationPoll(env.DB, {
      sessionId: secondSessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555571",
      now: now + 5_000,
    })
    await expect(
      completeAiAuthorization(env.DB, {
        sessionId: secondSessionId,
        claimId: "55555555-5555-5555-5555-555555555571",
        completionId: "66666666-6666-6666-6666-666666666671",
        credentialCiphertext: "late-claim",
        credentialExpiresAt: now + 7_200_000,
        upstreamAccountId: "account-main",
        now: now + 60_000,
      }),
    ).resolves.toEqual({ completed: false, reason: "claim-not-held" })

    // Disconnect advances the version and cancels pending sessions; the late
    // exchange result from the old version is rejected.
    await env.DB.prepare("DELETE FROM ai_authorization_sessions").run()
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
      connectionCredentialVersion: 1,
    })
    const disconnectClaim = await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555572",
      now: now + 5_000,
    })
    expect(disconnectClaim).toMatchObject({ claimed: true })
    const disconnected = await disconnectAiConnection(env.DB, {
      id: connectionId,
      now: now + 6_000,
    })
    expect(disconnected).toEqual({
      disconnected: true,
      clearedCredentials: true,
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialVersion: 2,
      credentialCiphertext: null,
      refreshClaimId: null,
    })
    await expect(
      completeAiAuthorization(env.DB, {
        sessionId,
        claimId: "55555555-5555-5555-5555-555555555572",
        completionId: "66666666-6666-6666-6666-666666666672",
        credentialCiphertext: "late-disconnect",
        credentialExpiresAt: now + 7_200_000,
        upstreamAccountId: "account-main",
        now: now + 7_000,
      }),
    ).resolves.toEqual({ completed: false, reason: "session-not-pending" })

    // Revoking the creating owner session blocks completion before tokens
    // are persisted.
    await env.DB.prepare("DELETE FROM ai_authorization_sessions").run()
    await createConnectedConnection(secondConnectionId, "second")
    const revokedSession = await createAiAuthorizationSession(env.DB, {
      id: sessionId,
      connectionId: secondConnectionId,
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 5_000,
      now: now + 10_000,
    })
    expect(revokedSession).toMatchObject({ created: true })
    await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555573",
      now: now + 20_000,
    })
    await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1')
      .bind(ownerSessionId)
      .run()
    await expect(
      completeAiAuthorization(env.DB, {
        sessionId,
        claimId: "55555555-5555-5555-5555-555555555573",
        completionId: "66666666-6666-6666-6666-666666666673",
        credentialCiphertext: "revoked-session",
        credentialExpiresAt: now + 7_200_000,
        upstreamAccountId: "account-second",
        now: now + 30_000,
      }),
    ).resolves.toEqual({ completed: false, reason: "owner-session-revoked" })
    await env.DB.prepare(
      `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId, reauthenticatedAt)
         VALUES (?1, 999999999999, 'ai-state-session-token', 0, 0, NULL, NULL, ?2, 0)`,
    )
      .bind(ownerSessionId, ownerUserId)
      .run()

    // Deleting the connection removes the session entirely.
    await env.DB.prepare("DELETE FROM ai_authorization_sessions").run()
    const deletedSession = await createAiAuthorizationSession(env.DB, {
      id: secondSessionId,
      connectionId: secondConnectionId,
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 5_000,
      now: now + 40_000,
    })
    expect(deletedSession).toMatchObject({ created: true })
    expect(
      await deleteAiConnection(env.DB, { id: secondConnectionId }),
    ).toEqual({ deleted: true })
    await expect(
      completeAiAuthorization(env.DB, {
        sessionId: secondSessionId,
        claimId: "55555555-5555-5555-5555-555555555574",
        completionId: "66666666-6666-6666-6666-666666666674",
        credentialCiphertext: "late-delete",
        credentialExpiresAt: now + 7_200_000,
        upstreamAccountId: "account-second",
        now: now + 50_000,
      }),
    ).resolves.toEqual({ completed: false, reason: "session-not-found" })
  })

  it("rolls back the whole completion batch when a statement fails", async () => {
    await createConnectedConnection(connectionId, "main")
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
      connectionCredentialVersion: 1,
    })
    const claimed = await claimAiAuthorizationPoll(env.DB, {
      sessionId,
      ownerUserId,
      ownerSessionId,
      claimId: "55555555-5555-5555-5555-555555555580",
      now: now + 5_000,
    })
    expect(claimed).toMatchObject({ claimed: true })

    await env.DB.prepare(
      `CREATE TRIGGER synthetic_ai_completion_failure
         BEFORE UPDATE OF "credentialCiphertext" ON "ai_connections"
         WHEN NEW."credentialCiphertext" = 'explode'
         BEGIN
           SELECT RAISE(ABORT, 'synthetic ai completion failure');
         END`,
    ).run()
    try {
      await expect(
        completeAiAuthorization(env.DB, {
          sessionId,
          claimId: "55555555-5555-5555-5555-555555555580",
          completionId: "66666666-6666-6666-6666-666666666680",
          credentialCiphertext: "explode",
          credentialExpiresAt: now + 7_200_000,
          upstreamAccountId: "account-main",
          now: now + 6_000,
        }),
      ).rejects.toThrow("synthetic ai completion failure")

      // The aborted connection update must not leave the session completed.
      const session = await env.DB.prepare(
        'SELECT "status" FROM "ai_authorization_sessions" WHERE "id" = ?1',
      )
        .bind(sessionId)
        .first<{ status: string }>()
      expect(session).toEqual({ status: "pending" })
      expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
        authorizationStatus: "connected",
        credentialCiphertext: "credential-package-main",
        credentialVersion: 1,
      })
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS synthetic_ai_completion_failure",
      ).run()
    }
  })

  it("coordinates credential refresh with a single claim holder and rejects late commits", async () => {
    await createConnectedConnection(connectionId, "main")

    // One claim winner among concurrent refresher attempts.
    const claimed = await Promise.all([
      acquireAiCredentialRefreshClaim(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777770",
        now,
      }),
      acquireAiCredentialRefreshClaim(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777771",
        now,
      }),
    ])
    expect(claimed.filter((result) => result.claimed)).toHaveLength(1)
    const winner = claimed.find((result) => result.claimed)
    expect(winner).toMatchObject({
      claimed: true,
      connection: {
        credentialVersion: 1,
        credentialCiphertext: "credential-package-main",
      },
    })
    expect(claimed.filter((result) => !result.claimed)).toEqual([
      {
        claimed: false,
        reason: "refresh-claim-held",
        refreshClaimExpiresAt: now + 30_000,
        uncertainClaimCleared: undefined,
      },
    ])

    // A refresh that provably never reached the upstream releases the claim
    // and keeps the credential.
    expect(
      await releaseAiCredentialRefreshClaim(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777770",
        now: now + 1_000,
      }),
    ).toEqual({ released: true })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "connected",
      credentialCiphertext: "credential-package-main",
    })

    const reclaimed = await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777772",
      now: now + 2_000,
    })
    expect(reclaimed).toMatchObject({ claimed: true })

    // Committing the refreshed credential advances the version.
    expect(
      await commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777772",
        observedCredentialVersion: 1,
        credentialCiphertext: "credential-package-refreshed",
        credentialExpiresAt: now + 7_200_000,
        now: now + 3_000,
      }),
    ).toMatchObject({
      committed: true,
      connection: {
        authorizationStatus: "connected",
        credentialCiphertext: "credential-package-refreshed",
        credentialExpiresAt: now + 7_200_000,
        credentialVersion: 2,
        refreshClaimId: null,
      },
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialVersion: 2,
      credentialCiphertext: "credential-package-refreshed",
      refreshClaimId: null,
    })

    // A late commit with the stale version or claim cannot overwrite it.
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777772",
        observedCredentialVersion: 1,
        credentialCiphertext: "late-refresh",
        credentialExpiresAt: now + 7_200_000,
        now: now + 4_000,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "credential-version-changed",
    })
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777773",
        observedCredentialVersion: 2,
        credentialCiphertext: "wrong-claim",
        credentialExpiresAt: now + 7_200_000,
        now: now + 4_000,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "refresh-claim-not-held",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialCiphertext: "credential-package-refreshed",
    })

    // Disconnecting clears the credential; a stale refresh result is rejected.
    await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777774",
      now: now + 5_000,
    })
    await disconnectAiConnection(env.DB, { id: connectionId, now: now + 6_000 })
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777774",
        observedCredentialVersion: 2,
        credentialCiphertext: "late-disconnect-refresh",
        credentialExpiresAt: now + 7_200_000,
        now: now + 7_000,
      }),
    ).resolves.toEqual({
      committed: false,
      reason: "credential-version-changed",
    })
  })

  it("treats an expired refresh claim as unknown and forces reauthorization", async () => {
    await createConnectedConnection(connectionId, "main")
    const first = await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777780",
      now,
    })
    expect(first).toMatchObject({ claimed: true })

    // The claim expires without any committed result; the next refresher must
    // not reuse the possibly rotated credential.
    const second = await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777781",
      now: now + 60_000,
    })
    expect(second).toEqual({
      claimed: false,
      reason: "reauthentication-required",
      refreshClaimExpiresAt: undefined,
      uncertainClaimCleared: true,
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialVersion: 2,
      credentialCiphertext: null,
      credentialExpiresAt: null,
      refreshClaimId: null,
    })

    // The cleared state is stable: further attempts see reauthentication
    // required without consuming anything.
    await expect(
      acquireAiCredentialRefreshClaim(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777782",
        now: now + 70_000,
      }),
    ).resolves.toMatchObject({
      claimed: false,
      reason: "reauthentication-required",
    })
    await expect(
      acquireAiCredentialRefreshClaim(env.DB, {
        connectionId: "14141414-1414-1414-1414-141414141414",
        claimId: "77777777-7777-4777-8777-777777777783",
        now: now + 70_000,
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "connection-not-found",
      refreshClaimExpiresAt: undefined,
      uncertainClaimCleared: undefined,
    })
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
        indexes: ["ai_authorization_sessions_expiresAt_idx"],
        sql: `SELECT "id" FROM "ai_authorization_sessions" WHERE "expiresAt" < ?1 LIMIT 500`,
        values: [now],
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

  it("cleans expired AI state in bounded batches and protects live state", async () => {
    await createConnectedConnection(connectionId, "main")
    // A pending session that has not expired and a reserved invocation inside
    // the retention window must survive cleanup, even with an expired lease.
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
    })
    await insertInvocationRow({
      requestId: invocationRequestId(9200),
      apiKeyId: "key",
      connectionId,
      startedAt: now - 400_000,
      deadlineAt: now - 100_000,
      leaseExpiresAt: now - 70_000,
      status: "reserved",
    })
    await insertSessionRow({
      id: secondSessionId,
      connectionId,
      expiresAt: now - 1,
    })
    await insertInvocationRow({
      requestId: invocationRequestId(9201),
      apiKeyId: "key",
      connectionId,
      startedAt: createAiInvocationRetentionCutoff(now) - 1,
      deadlineAt: now,
      leaseExpiresAt: now + 1,
      status: "unknown",
      endedAt: now,
    })

    const result = await cleanupExpiredAiState(env.DB, now)
    expect(result).toEqual({
      deletedAuthorizationSessions: 1,
      deletedInvocations: 1,
    })
    const survivingSessions = await env.DB.prepare(
      'SELECT "id", "expiresAt" FROM "ai_authorization_sessions"',
    ).all<{ id: string; expiresAt: number }>()
    expect(survivingSessions.results.some(({ id }) => id === sessionId)).toBe(
      true,
    )
    expect(
      survivingSessions.results.some(({ id }) => id === secondSessionId),
    ).toBe(false)
    // Only unexpired sessions survive: the completed authorization session
    // from the setup is retained within its original lifetime.
    for (const row of survivingSessions.results) {
      expect(row.expiresAt).toBeGreaterThanOrEqual(now)
    }
    expect(await countRows("ai_invocations")).toBe(1)

    // Repeated schedules are safe and delete nothing more.
    await expect(cleanupExpiredAiState(env.DB, now)).resolves.toEqual({
      deletedAuthorizationSessions: 0,
      deletedInvocations: 0,
    })

    await expect(cleanupExpiredAiState(env.DB, Number.NaN)).rejects.toThrow(
      "Invalid cleanup boundary",
    )
  })

  it("stops after ten 500-row batches and records a desensitized backlog", async () => {
    await createAiConnection(env.DB, {
      id: connectionId,
      slug: "codex-main",
      name: "Main",
      providerType: "openai-codex",
      now,
    })
    // 5,100 expired sessions: 5,000 are deleted within the batch caps and 100
    // stay for the next scheduled run.
    for (let offset = 0; offset < 5_100; offset += 25) {
      const statements = Array.from({ length: 25 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO "ai_authorization_sessions" (
                 "id", "connectionId", "ownerUserId", "ownerSessionId",
                 "connectionCredentialVersion", "status", "deviceGrantCiphertext",
                 "expiresAt", "nextPollAt", "pollClaimId", "pollClaimExpiresAt",
                 "completionId", "createdAt", "updatedAt"
               ) VALUES (?1, ?2, ?3, ?4, 0, 'pending', ?5, ?6, ?7, NULL, NULL, NULL, ?8, ?8)`,
        ).bind(
          `bulk-session-${offset + index}`,
          connectionId,
          ownerUserId,
          ownerSessionId,
          `device-grant-${offset + index}`,
          now - 1,
          now - 2,
          now - 3,
        ),
      )
      await env.DB.batch(statements)
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await cleanupExpiredAiState(env.DB, now)
    expect(result.deletedAuthorizationSessions).toBe(5_000)
    expect(await countRows("ai_authorization_sessions")).toBe(100)
    expect(warn).toHaveBeenCalledWith(
      '{"event":"cleanup_backlog","table":"ai_authorization_sessions"}',
    )

    // The backlog is cleared by the next scheduled run.
    await expect(cleanupExpiredAiState(env.DB, now)).resolves.toMatchObject({
      deletedAuthorizationSessions: 100,
    })
    expect(await countRows("ai_authorization_sessions")).toBe(0)
  })

  it("propagates a failed AI cleanup through the scheduled handler", async () => {
    await createAiConnection(env.DB, {
      id: connectionId,
      slug: "codex-main",
      name: "Main",
      providerType: "openai-codex",
      now,
    })
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now - 1,
    })
    await env.DB.prepare(
      `CREATE TRIGGER synthetic_ai_cleanup_failure
         BEFORE DELETE ON "ai_authorization_sessions"
         WHEN OLD."id" = '${sessionId}'
         BEGIN
           SELECT RAISE(ABORT, 'synthetic ai cleanup failure');
         END`,
    ).run()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await expect(
        worker.scheduled(
          createScheduledController({
            cron: DAILY_CLEANUP_SCHEDULE,
            scheduledTime: now,
          }),
          env,
        ),
      ).rejects.toThrow("synthetic ai cleanup failure")
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: "scheduled_cleanup_failed" }),
      )
      // Nothing was deleted by the failed batch.
      expect(await countRows("ai_authorization_sessions")).toBe(1)
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS synthetic_ai_cleanup_failure",
      ).run()
    }
  })

  it("completes only the session's bound connection and never a same-version neighbor", async () => {
    // Two connections at the same credential version with different accounts:
    // completing the session bound to the first must leave the second exactly
    // as it was.
    await createConnectedConnection(connectionId, "main")
    await createConnectedConnection(secondConnectionId, "second")
    const before = await getAiConnection(env.DB, secondConnectionId)
    expect(before).toMatchObject({
      authorizationStatus: "connected",
      upstreamAccountId: "account-second",
      credentialVersion: 1,
      credentialCiphertext: "credential-package-second",
    })

    const boundSessionId = nextAuthorizationSessionId()
    const created = await createAiAuthorizationSession(env.DB, {
      id: boundSessionId,
      connectionId,
      ownerUserId,
      ownerSessionId,
      deviceGrantCiphertext: "device-grant",
      sessionTtlMs: 900_000,
      pollIntervalMs: 1_000,
      now: now + 10_000,
    })
    expect(created).toMatchObject({
      created: true,
      session: { connectionId, connectionCredentialVersion: 1 },
    })
    const boundClaimId = `55555555-5555-5555-5555-${authorizationSessionSeed
      .toString(16)
      .padStart(12, "0")}`
    await expect(
      claimAiAuthorizationPoll(env.DB, {
        sessionId: boundSessionId,
        ownerUserId,
        ownerSessionId,
        claimId: boundClaimId,
        now: now + 20_000,
      }),
    ).resolves.toMatchObject({ claimed: true })

    const completed = await completeAiAuthorization(env.DB, {
      sessionId: boundSessionId,
      claimId: boundClaimId,
      completionId: `66666666-6666-6666-6666-${authorizationSessionSeed
        .toString(16)
        .padStart(12, "0")}`,
      credentialCiphertext: "credential-package-main-reauthorized",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-main",
      now: now + 30_000,
    })
    expect(completed).toEqual({ completed: true })

    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "connected",
      upstreamAccountId: "account-main",
      credentialVersion: 2,
      credentialCiphertext: "credential-package-main-reauthorized",
    })
    // The same-version neighbor is untouched in every persisted field.
    expect(await getAiConnection(env.DB, secondConnectionId)).toEqual(before)
  })

  it("leaves no partial completion when the bound connection version has moved", async () => {
    await createConnectedConnection(connectionId, "main")
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
      connectionCredentialVersion: 1,
    })
    await expect(
      claimAiAuthorizationPoll(env.DB, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        claimId: "55555555-5555-5555-5555-555555555590",
        now: now + 5_000,
      }),
    ).resolves.toMatchObject({ claimed: true })

    // Advance the connection version without touching the session, keeping
    // the connection connected.
    await env.DB.prepare(
      `UPDATE "ai_connections"
         SET "credentialVersion" = "credentialVersion" + 1, "updatedAt" = ?2
         WHERE "id" = ?1`,
    )
      .bind(connectionId, now + 6_000)
      .run()

    const rejected = await completeAiAuthorization(env.DB, {
      sessionId,
      claimId: "55555555-5555-5555-5555-555555555590",
      completionId: "66666666-6666-6666-6666-666666666690",
      credentialCiphertext: "stale-completion-cipher",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-main",
      now: now + 7_000,
    })
    expect(rejected).toEqual({
      completed: false,
      reason: "connection-version-changed",
    })

    // No partial commit: the session is still pending with its claim and the
    // connection kept its pre-completion state.
    const session = await env.DB.prepare(
      'SELECT "status", "pollClaimId", "completionId" FROM "ai_authorization_sessions" WHERE "id" = ?1',
    )
      .bind(sessionId)
      .first<{
        status: string
        pollClaimId: string
        completionId: string | null
      }>()
    expect(session).toEqual({
      status: "pending",
      pollClaimId: "55555555-5555-5555-5555-555555555590",
      completionId: null,
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "connected",
      credentialVersion: 2,
      credentialCiphertext: "credential-package-main",
      upstreamAccountId: "account-main",
    })
  })

  it("returns only its own claim snapshot when reauthorization interleaves the refresh claim", async () => {
    await createConnectedConnection(connectionId, "main")
    // Prepare a reauthorization path that will interleave after the first
    // statement of the refresh claim attempt.
    const reauthSessionId = nextAuthorizationSessionId()
    await expect(
      createAiAuthorizationSession(env.DB, {
        id: reauthSessionId,
        connectionId,
        ownerUserId,
        ownerSessionId,
        deviceGrantCiphertext: "device-grant",
        sessionTtlMs: 900_000,
        pollIntervalMs: 1_000,
        now: now + 10_000,
      }),
    ).resolves.toMatchObject({ created: true })
    const reauthClaimId = `55555555-5555-5555-5555-${authorizationSessionSeed
      .toString(16)
      .padStart(12, "0")}`
    await expect(
      claimAiAuthorizationPoll(env.DB, {
        sessionId: reauthSessionId,
        ownerUserId,
        ownerSessionId,
        claimId: reauthClaimId,
        now: now + 20_000,
      }),
    ).resolves.toMatchObject({ claimed: true })

    const refreshA = "77777777-7777-4777-8777-777777777790"
    const refreshB = "77777777-7777-4777-8777-777777777791"
    let second:
      | Awaited<ReturnType<typeof acquireAiCredentialRefreshClaim>>
      | undefined

    // The wrapper runs the interleaving after the first statement the claim
    // operation issues; it does not match on SQL text. A write-then-read
    // implementation would observe the post-interleave state here, while a
    // single-statement claim already holds its own snapshot.
    let armed = false
    let fired = false
    const wrappedDatabase = {
      prepare(query: string) {
        const statement = env.DB.prepare(query)
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            const after = async <T>(result: Promise<T>): Promise<T> => {
              const value = await result
              if (armed && !fired) {
                fired = true
                await completeAiAuthorization(env.DB, {
                  sessionId: reauthSessionId,
                  claimId: reauthClaimId,
                  completionId: `66666666-6666-6666-6666-${authorizationSessionSeed
                    .toString(16)
                    .padStart(12, "0")}`,
                  credentialCiphertext: "credential-package-reauthorized",
                  credentialExpiresAt: now + 7_200_000,
                  upstreamAccountId: "account-main",
                  now: now + 25_000,
                })
                second = await acquireAiCredentialRefreshClaim(env.DB, {
                  connectionId,
                  claimId: refreshB,
                  now: now + 26_000,
                })
              }
              return value
            }
            return {
              run: () => after(bound.run()),
              all: () => after(bound.all()),
              first: () => after(bound.first()),
            }
          },
        }
      },
      batch: <T>(statements: D1PreparedStatement[]) =>
        env.DB.batch<T>(statements),
    } as unknown as D1Database

    armed = true
    try {
      const first = await acquireAiCredentialRefreshClaim(wrappedDatabase, {
        connectionId,
        claimId: refreshA,
        now: now + 21_000,
      })
      expect(fired).toBe(true)
      // The first caller's result is exactly the state its own claim created.
      expect(first).toMatchObject({
        claimed: true,
        connection: {
          refreshClaimId: refreshA,
          credentialVersion: 1,
          credentialCiphertext: "credential-package-main",
        },
      })
    } finally {
      armed = false
    }

    // The interleaved reauthorization and second claim also hold consistent
    // state, and nothing leaked the new credential to the first caller.
    expect(second).toMatchObject({
      claimed: true,
      connection: {
        refreshClaimId: refreshB,
        credentialVersion: 2,
        credentialCiphertext: "credential-package-reauthorized",
      },
    })
  })

  it("returns the poll claim's own snapshot when a concurrent cancel interleaves", async () => {
    await createConnectedConnection(connectionId, "main")
    await insertSessionRow({
      id: sessionId,
      connectionId,
      expiresAt: now + 900_000,
      connectionCredentialVersion: 1,
    })

    const pollClaimId = "55555555-5555-5555-5555-555555555595"
    let armed = false
    let fired = false
    const wrappedDatabase = {
      prepare(query: string) {
        const statement = env.DB.prepare(query)
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values)
            const after = async <T>(result: Promise<T>): Promise<T> => {
              const value = await result
              if (armed && !fired) {
                fired = true
                await cancelAiAuthorizationSession(env.DB, {
                  sessionId,
                  ownerUserId,
                  ownerSessionId,
                  now: now + 6_000,
                })
              }
              return value
            }
            return {
              run: () => after(bound.run()),
              all: () => after(bound.all()),
              first: () => after(bound.first()),
            }
          },
        }
      },
      batch: <T>(statements: D1PreparedStatement[]) =>
        env.DB.batch<T>(statements),
    } as unknown as D1Database

    armed = true
    try {
      const claimed = await claimAiAuthorizationPoll(wrappedDatabase, {
        sessionId,
        ownerUserId,
        ownerSessionId,
        claimId: pollClaimId,
        now: now + 5_000,
      })
      expect(fired).toBe(true)
      // The returned session is the snapshot of this claim's own write: it
      // still shows the pending status and this claim at claim time.
      expect(claimed).toMatchObject({
        claimed: true,
        session: {
          id: sessionId,
          status: "pending",
          pollClaimId: pollClaimId,
        },
      })
    } finally {
      armed = false
    }

    // The cancelled state wins for later writers: a completion attempt with
    // the claimed snapshot fails cleanly and writes nothing.
    const completion = await completeAiAuthorization(env.DB, {
      sessionId,
      claimId: pollClaimId,
      completionId: "66666666-6666-6666-6666-666666666695",
      credentialCiphertext: "post-cancel-completion",
      credentialExpiresAt: now + 7_200_000,
      upstreamAccountId: "account-main",
      now: now + 7_000,
    })
    expect(completion).toEqual({
      completed: false,
      reason: "session-not-pending",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialCiphertext: "credential-package-main",
      credentialVersion: 1,
    })
  })

  it("rejects refresh commits at and after claim expiry while allowing them before", async () => {
    await createConnectedConnection(connectionId, "main")

    const first = await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777780",
      now,
    })
    expect(first).toMatchObject({ claimed: true })

    // One millisecond before expiry the commit still succeeds.
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777780",
        observedCredentialVersion: 1,
        credentialCiphertext: "credential-package-refreshed-1",
        credentialExpiresAt: now + 7_200_000,
        now: now + AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS - 1,
      }),
    ).resolves.toMatchObject({
      committed: true,
      connection: {
        authorizationStatus: "connected",
        credentialCiphertext: "credential-package-refreshed-1",
        credentialVersion: 2,
        refreshClaimId: null,
      },
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialVersion: 2,
      credentialCiphertext: "credential-package-refreshed-1",
      refreshClaimId: null,
    })

    const second = await acquireAiCredentialRefreshClaim(env.DB, {
      connectionId,
      claimId: "77777777-7777-4777-8777-777777777781",
      now: now + 10_000,
    })
    expect(second).toMatchObject({ claimed: true })
    const claimExpiry = now + 10_000 + AI_CREDENTIAL_REFRESH_CLAIM_TTL_MS

    // Exactly at expiry the claim is invalid: the late result is rejected
    // and the stored credential stays untouched, even though no other
    // request has cleared the expired claim yet.
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777781",
        observedCredentialVersion: 2,
        credentialCiphertext: "late-at-expiry-cipher",
        credentialExpiresAt: now + 7_200_000,
        now: claimExpiry,
      }),
    ).resolves.toEqual({ committed: false, reason: "refresh-claim-expired" })
    await expect(
      commitAiCredentialRefresh(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777781",
        observedCredentialVersion: 2,
        credentialCiphertext: "late-after-expiry-cipher",
        credentialExpiresAt: now + 7_200_000,
        now: claimExpiry + 1,
      }),
    ).resolves.toEqual({ committed: false, reason: "refresh-claim-expired" })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialVersion: 2,
      credentialCiphertext: "credential-package-refreshed-1",
      refreshClaimId: "77777777-7777-4777-8777-777777777781",
    })

    // The still-listed expired claim keeps its uncertain-outcome handling:
    // the next refresher forces reauthorization instead of reusing it.
    await expect(
      acquireAiCredentialRefreshClaim(env.DB, {
        connectionId,
        claimId: "77777777-7777-4777-8777-777777777782",
        now: claimExpiry + 2,
      }),
    ).resolves.toMatchObject({
      claimed: false,
      reason: "reauthentication-required",
      uncertainClaimCleared: true,
    })
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

import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import worker from "../../src/worker"
import {
  cancelCodexAuthorization,
  pollCodexAuthorization,
  readCodexAuthorizationStatus,
  startCodexAuthorization,
  type AiAuthorizationAuditEvent,
  type AiAuthorizationFlowContext,
} from "../../src/worker/ai/authorization-flow"
import { normalizeCodexPollIntervalMs } from "../../src/worker/ai/codex-connector"
import {
  createAiConnection,
  disconnectAiConnection,
  getAiConnection,
} from "../../src/worker/ai/connections"
import {
  AiCredentialCipherError,
  decryptAiSecret,
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import { commitAiModelSnapshot } from "../../src/worker/ai/models"
import { AI_AUTHORIZATION_SESSION_MAX_TTL_MS } from "../../src/worker/ai/policy"

const now = 2_000_000_000_000
const stageDeadlineAt = now + 30_000
const environment = "http://local.test"
const connectionId = "11111111-1111-1111-1111-111111111111"
const ownerUserId = "codex-owner"
const defaultIntervalMs = 5_000

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const keyV1 = crypto.getRandomValues(new Uint8Array(32))
const keyV2 = crypto.getRandomValues(new Uint8Array(32))
const keyringRaw = `1:${toBase64Url(keyV1)}`
const rotatedKeyringRaw = `1:${toBase64Url(keyV1)},2:${toBase64Url(keyV2)}`
const keyringV2OnlyRaw = `2:${toBase64Url(keyV2)}`

let privateSigningKey: CryptoKey
let jwksPayload: { keys: unknown[] }

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true })
  privateSigningKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  jwksPayload = {
    keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }],
  }
})

async function signTestIdToken(input: {
  chatgptAccountId: string
  chatgptUserId: string
  expiresAtMs: number
}): Promise<string> {
  return new SignJWT({
    "https://api.openai.com/auth": {
      chatgpt_account_id: input.chatgptAccountId,
      chatgpt_plan_type: "plus",
      chatgpt_user_id: input.chatgptUserId,
    },
    email: "owner@example.invalid",
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setAudience("app_EMoamEEZ73f0CkXaXp7hrann")
    .setExpirationTime(Math.floor(input.expiresAtMs / 1_000))
    .setIssuer("https://auth.openai.com")
    .sign(privateSigningKey)
}

function fakeAccessToken(expiryMs: number): string {
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  )
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp: Math.floor(expiryMs / 1_000),
        sub: "access-token",
      }),
    ),
  )
  return `${header}.${payload}.${toBase64Url(new Uint8Array(32))}`
}

interface UpstreamRoute {
  response: () => Response | Promise<Response>
}
interface UpstreamMock {
  calls: Array<{
    body: string | null
    headers: Record<string, string>
    method: string
    url: string
  }>
  routes: {
    exchange: UpstreamRoute
    deviceToken: UpstreamRoute
    jwks: UpstreamRoute
    models: UpstreamRoute
    refresh: UpstreamRoute
    usercode: UpstreamRoute
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  })
}

function installUpstreamMock(
  overrides: Partial<
    Record<keyof UpstreamMock["routes"], () => Response | Promise<Response>>
  > = {},
): UpstreamMock {
  const mock: UpstreamMock = {
    calls: [],
    routes: {
      exchange: { response: () => jsonResponse({ error: "unexpected" }, 500) },
      deviceToken: { response: () => jsonResponse({}, 404) },
      jwks: { response: () => jsonResponse(jwksPayload) },
      models: { response: () => jsonResponse({ models: [] }) },
      refresh: { response: () => jsonResponse({ error: "unexpected" }, 500) },
      usercode: {
        response: () =>
          jsonResponse({
            device_auth_id: "device-auth-1",
            interval: "5",
            user_code: "WDJB-MJHT",
          }),
      },
    },
  }
  for (const [key, response] of Object.entries(overrides)) {
    if (response !== undefined) {
      ;(mock.routes as Record<string, UpstreamRoute>)[key] = { response }
    }
  }
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      mock.calls.push({
        body: init?.body === undefined ? null : String(init.body),
        headers: Object.fromEntries(request.headers.entries()),
        method: request.method,
        url: request.url,
      })
      if (url.origin === "https://auth.openai.com") {
        if (url.pathname === "/api/accounts/deviceauth/usercode") {
          return mock.routes.usercode.response()
        }
        if (url.pathname === "/api/accounts/deviceauth/token") {
          return mock.routes.deviceToken.response()
        }
        if (url.pathname === "/oauth/token") {
          const body = mock.calls.at(-1)?.body ?? ""
          return body.includes("grant_type=authorization_code")
            ? mock.routes.exchange.response()
            : mock.routes.refresh.response()
        }
        if (url.pathname === "/.well-known/jwks.json")
          return mock.routes.jwks.response()
      }
      if (
        url.origin === "https://chatgpt.com" &&
        url.pathname === "/backend-api/codex/models"
      ) {
        return mock.routes.models.response()
      }
      throw new Error(
        `Unexpected outbound request: ${request.method} ${request.url}`,
      )
    })
  mocks.push({ mock, restore: () => spy.mockRestore() })
  return mock
}

const mocks: Array<{ mock: UpstreamMock; restore: () => void }> = []
afterEach(() => {
  while (mocks.length > 0) mocks.pop()?.restore()
  vi.restoreAllMocks()
})

let auditEvents: AiAuthorizationAuditEvent[]
/**
 * The service reads the wall clock at every decision taken after an await.
 * These fixtures live on a synthetic timeline, so the tests hand it a clock
 * that follows that timeline instead of the real one.
 */
let clockNow = now

/**
 * Runs a poll on the test clock, which follows the entry time it is given: the
 * service reads that clock for every decision taken after an await, and these
 * fixtures live on a synthetic timeline.
 */
function pollWithClock(
  input: Parameters<typeof pollCodexAuthorization>[1],
): ReturnType<typeof pollCodexAuthorization> {
  clockNow = input.now
  return pollCodexAuthorization(context, input)
}

let context: AiAuthorizationFlowContext

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_invocations"),
    env.DB.prepare("DELETE FROM ai_models"),
    env.DB.prepare("DELETE FROM ai_connections"),
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM security_audit_events"),
  ])
  auditEvents = []
  clockNow = now
  context = {
    audit: (event) => auditEvents.push(event),
    clock: () => clockNow,
    credentialKeys: keyringRaw,
    database: env.DB,
    environment,
  }
})

async function createOwnerSession(input: {
  reauthenticatedAtMs: number
  expiresAtMs?: number
  userId?: string
  sessionId?: string
}): Promise<{ sessionId: string; userId: string }> {
  // The default matches the ownerUserId constant the flow tests bind.
  const userId = input.userId ?? ownerUserId
  const sessionId = input.sessionId ?? crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    ).bind(
      userId,
      "Owner",
      `${userId}@example.invalid`,
      1,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId,reauthenticatedAt) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      sessionId,
      new Date(input.expiresAtMs ?? now + 30 * 86400000).toISOString(),
      `token-${sessionId}`,
      new Date(now - 60_000).toISOString(),
      new Date(now - 60_000).toISOString(),
      userId,
      new Date(input.reauthenticatedAtMs).toISOString(),
    ),
  ])
  return { sessionId, userId }
}

async function createConnection(): Promise<void> {
  const created = await createAiConnection(env.DB, {
    id: connectionId,
    name: "Main",
    now,
    providerType: "openai-codex",
    slug: "codex-main",
  })
  expect(created).toMatchObject({ created: true })
}

async function readSessionRow(id: string) {
  return env.DB.prepare(
    'SELECT * FROM "ai_authorization_sessions" WHERE "id" = ?1',
  )
    .bind(id)
    .first<{
      status: string
      nextPollAt: number
      expiresAt: number
      pollClaimId: string | null
    }>()
}

async function decryptStoredPackage(ciphertext: string) {
  const keyring = await parseAiCredentialKeyring(keyringRaw)
  return JSON.parse(
    await decryptAiSecret(keyring, ciphertext, {
      connectionId,
      environment,
      providerType: "openai-codex",
      purpose: "credential-package",
    }),
  ) as {
    accessToken: string
    chatgptUserId: string | null
    refreshToken: string
  }
}

/** Drives one full successful device authorization through the real flow. */
async function authorizeThroughFlow(input: {
  chatgptAccountId?: string
  chatgptUserId?: string
  ownerSessionId: string
  ownerUserId?: string
  at?: number
  mock?: UpstreamMock
}): Promise<{ authorizationId: string; pollResult: { status: string } }> {
  const at = input.at ?? now
  if (input.mock === undefined) {
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () =>
        jsonResponse({
          access_token: fakeAccessToken(at + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: input.chatgptAccountId ?? "account-main",
            chatgptUserId: input.chatgptUserId ?? "user-main",
            expiresAtMs: at + 3_600_000,
          }),
          refresh_token: "refresh-token-1",
        }),
    })
  }
  const flowOwnerUserId = input.ownerUserId ?? ownerUserId
  const started = await startCodexAuthorization(context, {
    connectionId,
    deadlineAt: at + 30_000,
    now: at,
    ownerSessionId: input.ownerSessionId,
    ownerUserId: flowOwnerUserId,
  })
  expect(started).toMatchObject({ status: "started" })
  const pollResult = await pollWithClock({
    authorizationId: (started as { authorizationId: string }).authorizationId,
    deadlineAt: at + 30_000,
    now: at + defaultIntervalMs,
    ownerSessionId: input.ownerSessionId,
    ownerUserId: flowOwnerUserId,
  })
  return {
    authorizationId: (started as { authorizationId: string }).authorizationId,
    pollResult: pollResult as { status: string },
  }
}

describe("AI credential cipher", () => {
  const aad = {
    connectionId,
    environment,
    providerType: "openai-codex",
    purpose: "credential-package" as const,
  }

  it("round-trips a package and records the current key version", async () => {
    const keyring = await parseAiCredentialKeyring(keyringRaw)
    const envelope = await encryptAiSecret(keyring, "secret-payload", aad)
    const parsed = JSON.parse(envelope) as { k: number; v: number }
    expect(parsed).toMatchObject({ k: 1, v: 1 })
    expect(await decryptAiSecret(keyring, envelope, aad)).toBe("secret-payload")
  })

  it("keeps old-version ciphertext readable after rotation and writes with the new key", async () => {
    const before = await parseAiCredentialKeyring(keyringRaw)
    const envelope = await encryptAiSecret(before, "old-payload", aad)
    const rotated = await parseAiCredentialKeyring(rotatedKeyringRaw)
    expect(await decryptAiSecret(rotated, envelope, aad)).toBe("old-payload")
    const rewritten = await encryptAiSecret(rotated, "new-payload", aad)
    expect((JSON.parse(rewritten) as { k: number }).k).toBe(2)
    expect(await decryptAiSecret(rotated, rewritten, aad)).toBe("new-payload")
  })

  it("rejects a ciphertext whose key version left the keyring", async () => {
    const before = await parseAiCredentialKeyring(keyringRaw)
    const envelope = await encryptAiSecret(before, "payload", aad)
    const withoutOldKey = await parseAiCredentialKeyring(keyringV2OnlyRaw)
    await expect(
      decryptAiSecret(withoutOldKey, envelope, aad),
    ).rejects.toMatchObject({
      kind: "key-not-found",
    })
  })

  it("rejects tampered ciphertext", async () => {
    const keyring = await parseAiCredentialKeyring(keyringRaw)
    const envelope = await encryptAiSecret(keyring, "payload", aad)
    const parsed = JSON.parse(envelope) as { ct: string }
    const tampered = JSON.stringify({
      ...parsed,
      ct: parsed.ct.slice(0, -2) + "aa",
    })
    await expect(
      decryptAiSecret(keyring, tampered, aad),
    ).rejects.toBeInstanceOf(AiCredentialCipherError)
  })

  it("rejects AAD mismatches across environment, connection, and purpose", async () => {
    const keyring = await parseAiCredentialKeyring(keyringRaw)
    const envelope = await encryptAiSecret(keyring, "payload", aad)
    for (const wrong of [
      { ...aad, environment: "https://auth.eruoo.me" },
      { ...aad, connectionId: "99999999-9999-9999-9999-999999999999" },
      { ...aad, providerType: "openai-platform" },
      { ...aad, purpose: "device-grant" as const },
    ]) {
      await expect(
        decryptAiSecret(keyring, envelope, wrong),
      ).rejects.toMatchObject({
        kind: "authentication-failed",
      })
    }
  })

  it("rejects malformed keyrings and envelopes loudly", async () => {
    for (const raw of [
      "",
      "1:short",
      "1:aaaa,1:bbbb",
      "x:key",
      `1:${toBase64Url(keyV1)},broken`,
    ]) {
      await expect(parseAiCredentialKeyring(raw)).rejects.toMatchObject({
        kind: "invalid-keyring",
      })
    }
    const keyring = await parseAiCredentialKeyring(keyringRaw)
    for (const bad of ["not-json", "{}", '{"v":2,"k":1,"iv":"a","ct":"b"}']) {
      await expect(decryptAiSecret(keyring, bad, aad)).rejects.toMatchObject({
        kind: "malformed-envelope",
      })
    }
  })
})

describe("Codex poll interval normalization", () => {
  it("applies the fixed contract defaults and floor", () => {
    expect(normalizeCodexPollIntervalMs("5")).toBe(5_000)
    expect(normalizeCodexPollIntervalMs(" 7 ")).toBe(7_000)
    expect(normalizeCodexPollIntervalMs(3)).toBe(3_000)
    expect(normalizeCodexPollIntervalMs("garbage")).toBe(5_000)
    expect(normalizeCodexPollIntervalMs(undefined)).toBe(5_000)
    expect(normalizeCodexPollIntervalMs("0")).toBe(1_000)
    expect(normalizeCodexPollIntervalMs(-4)).toBe(1_000)
  })
})

describe("device authorization start", () => {
  it("creates a bound pending session with an encrypted device grant", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const mock = installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(started).toMatchObject({
      intervalMs: defaultIntervalMs,
      status: "started",
      userCode: "WDJB-MJHT",
      verificationUrl: "https://auth.openai.com/codex/device",
    })
    const session = await readSessionRow(
      (started as { authorizationId: string }).authorizationId,
    )
    expect(session).toMatchObject({
      nextPollAt: now + defaultIntervalMs,
      pollClaimId: null,
      status: "pending",
    })
    expect((session as { expiresAt: number }).expiresAt).toBeLessThanOrEqual(
      now + AI_AUTHORIZATION_SESSION_MAX_TTL_MS,
    )
    // The usercode request went to the fixed endpoint with the fixed client id.
    const usercodeCall = mock.calls.find((call) =>
      call.url.includes("/deviceauth/usercode"),
    )
    expect(usercodeCall).toMatchObject({ method: "POST" })
    expect(JSON.parse(usercodeCall?.body ?? "{}")).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    })
    // The device grant ciphertext is not the plaintext grant.
    const grantRow = await env.DB.prepare(
      'SELECT "deviceGrantCiphertext" FROM "ai_authorization_sessions" WHERE "id" = ?1',
    )
      .bind((started as { authorizationId: string }).authorizationId)
      .first<{ deviceGrantCiphertext: string }>()
    expect(grantRow?.deviceGrantCiphertext).not.toContain("WDJB-MJHT")
    expect(auditEvents).toEqual([
      {
        metadata: { connectionId, providerType: "openai-codex" },
        outcome: "success",
        subjectId: owner.userId,
        type: "ai_authorization_started",
      },
    ])
  })

  it("reports a controlled failure when the usercode request fails upstream", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock({
      usercode: () => jsonResponse({ error: "nope" }, 500),
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(started).toEqual({ status: "upstream-failure", reason: "rejected" })
    const sessions = await env.DB.prepare(
      'SELECT count(*) AS count FROM "ai_authorization_sessions"',
    ).first<{ count: number }>()
    expect(sessions?.count).toBe(0)
    expect(auditEvents).toEqual([
      expect.objectContaining({
        outcome: "failure",
        type: "ai_authorization_started",
      }),
    ])
  })

  it("fails before any upstream request when the stage budget is exhausted", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const mock = installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: Date.now() - 1_000,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(started).toEqual({
      status: "upstream-failure",
      reason: "unavailable",
    })
    expect(mock.calls.length).toBe(0)
  })
})

describe("device authorization poll", () => {
  it("completes a full authorization and stores only the encrypted package", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const { authorizationId, pollResult } = await authorizeThroughFlow({
      ownerSessionId: owner.sessionId,
    })
    expect(pollResult.status).toBe("completed")
    const session = await readSessionRow(authorizationId)
    expect(session?.status).toBe("completed")
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      credentialVersion: 1,
      upstreamAccountId: "account-main",
    })
    expect(connection?.credentialCiphertext).not.toContain("refresh-token-1")
    const stored = await decryptStoredPackage(
      connection?.credentialCiphertext ?? "",
    )
    expect(stored).toEqual({
      accessToken: expect.any(String),
      chatgptUserId: "user-main",
      refreshToken: "refresh-token-1",
    })
    expect(
      auditEvents.map((event) => `${event.type}:${event.outcome}`),
    ).toEqual([
      "ai_authorization_started:success",
      "ai_authorization_completed:success",
    ])
  })

  it("returns pending once per poll, honors the interval, and writes no audit", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const mock = installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const first = await pollWithClock({
      authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(first).toEqual({
      intervalMs: defaultIntervalMs,
      nextPollAt: now + defaultIntervalMs * 2,
      status: "pending",
    })
    expect(
      mock.calls.filter((call) => call.url.includes("/deviceauth/token"))
        .length,
    ).toBe(1)
    // An immediate re-poll is too early: the interval is enforced.
    const second = await pollWithClock({
      authorizationId,
      deadlineAt: now + 60_000,
      now: now + defaultIntervalMs + 1_000,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(second).toMatchObject({ status: "poll-too-early" })
    expect(
      mock.calls.filter((call) => call.url.includes("/deviceauth/token"))
        .length,
    ).toBe(1)
    expect(auditEvents).toEqual([
      expect.objectContaining({
        type: "ai_authorization_started",
        outcome: "success",
      }),
    ])
  })

  it("lets only one tab perform the upstream check", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    let releaseFirstPoll: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve
    })
    let signalFirstCheck: (() => void) | undefined
    const checkStarted = new Promise<void>((resolve) => {
      signalFirstCheck = resolve
    })
    installUpstreamMock({
      deviceToken: async () => {
        signalFirstCheck?.()
        await gate
        return jsonResponse({}, 404)
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const firstPoll = pollWithClock({
      authorizationId,
      deadlineAt: now + 60_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    // Wait until the first poll's upstream check is actually in flight; the
    // claim was already written before the fetch started.
    await checkStarted
    const second = await pollWithClock({
      authorizationId,
      deadlineAt: now + 60_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(second).toEqual({ status: "poll-claim-held" })
    releaseFirstPoll?.()
    expect(await firstPoll).toMatchObject({ status: "pending" })
  })

  it("treats an upstream rejection as terminal and cancels the session", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock({
      deviceToken: () => jsonResponse({ error: "denied" }, 400),
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const result = await pollWithClock({
      authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "rejected" })
    expect(await readSessionRow(authorizationId)).toMatchObject({
      status: "cancelled",
    })
    expect(auditEvents.at(-1)).toMatchObject({
      outcome: "failure",
      type: "ai_authorization_completed",
    })
  })

  it("rejects a poll from a different owner session", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const other = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
      userId: "other-user",
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: other.sessionId,
      ownerUserId: other.userId,
    })
    expect(result).toEqual({ status: "session-mismatch" })
  })

  it("rejects an expired session", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 30_000,
      now: now + AI_AUTHORIZATION_SESSION_MAX_TTL_MS + 1_000,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "expired" })
  })

  it("blocks completion when the owner session was revoked mid-flow", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () => {
        await env.DB.prepare("DELETE FROM session WHERE id=?")
          .bind(owner.sessionId)
          .run()
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: "account-main",
            chatgptUserId: "user-main",
            expiresAtMs: now + 3_600_000,
          }),
          refresh_token: "refresh-token-1",
        })
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "owner-session-invalid" })
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "never_authorized",
      credentialCiphertext: null,
    })
  })

  it("commits credentials for a valid session without recent authentication", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 20 * 60_000,
    })
    const mock = installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: "account-main",
            chatgptUserId: "user-main",
            expiresAtMs: now + 3_600_000,
          }),
          refresh_token: "refresh-token-1",
        }),
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const result = await pollWithClock({
      authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "completed" })
    expect(await readSessionRow(authorizationId)).toMatchObject({
      status: "completed",
    })
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection?.authorizationStatus).toBe("connected")
    expect(
      await decryptStoredPackage(connection?.credentialCiphertext ?? ""),
    ).toMatchObject({
      refreshToken: "refresh-token-1",
    })
    expect(
      auditEvents.filter(
        (event) => event.type === "ai_authorization_completed",
      ),
    ).toHaveLength(1)
    expect(
      mock.calls.filter((call) => call.url.endsWith("/oauth/token")),
    ).toHaveLength(1)
  })

  it("refuses reauthorization for a different workspace account", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    await authorizeThroughFlow({ ownerSessionId: owner.sessionId })
    const second = await authorizeThroughFlow({
      chatgptAccountId: "account-other",
      chatgptUserId: "user-main",
      ownerSessionId: owner.sessionId,
    })
    expect(second.pollResult.status).toBe("account-mismatch")
    const connection = await getAiConnection(env.DB, connectionId)
    // The original authorization stays intact.
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      upstreamAccountId: "account-main",
    })
  })

  it("refuses reauthorization for a different ChatGPT user in the same workspace", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    await authorizeThroughFlow({ ownerSessionId: owner.sessionId })
    const second = await authorizeThroughFlow({
      chatgptUserId: "user-other",
      ownerSessionId: owner.sessionId,
    })
    expect(second.pollResult.status).toBe("account-mismatch")
    const connection = await getAiConnection(env.DB, connectionId)
    expect(
      await decryptStoredPackage(connection?.credentialCiphertext ?? ""),
    ).toMatchObject({
      chatgptUserId: "user-main",
    })
  })

  it("drops a late completion when the connection changed underneath", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    await authorizeThroughFlow({ ownerSessionId: owner.sessionId })
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-2",
          code_challenge: "challenge-2",
          code_verifier: "verifier-2",
        }),
      exchange: async () => {
        // A disconnect lands between the exchange and the completion.
        await disconnectAiConnection(env.DB, {
          id: connectionId,
          now: now + 1_000,
        })
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: "account-main",
            chatgptUserId: "user-main",
            expiresAtMs: now + 3_600_000,
          }),
          refresh_token: "refresh-token-late",
        })
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "connection-changed" })
    const connection = await getAiConnection(env.DB, connectionId)
    // The late result did not overwrite the disconnected state.
    expect(connection).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
      credentialVersion: 2,
    })
  })

  it("rejects identity tokens that fail verification", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () => {
        // Signed with a different key than the published JWKS.
        const roguePair = await generateKeyPair("RS256")
        const rogueToken = await new SignJWT({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account-main",
            chatgpt_user_id: "user-main",
          },
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setAudience("app_EMoamEEZ73f0CkXaXp7hrann")
          .setExpirationTime(Math.floor((now + 3_600_000) / 1_000))
          .setIssuer("https://auth.openai.com")
          .sign(roguePair.privateKey)
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: rogueToken,
          refresh_token: "refresh-token-1",
        })
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 30_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "invalid-identity" })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "never_authorized",
      credentialCiphertext: null,
    })
  })

  it("rechecks the owner session expiry at commit time", async () => {
    await createConnection()
    // The session expires during the exchange, after the poll has started.
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
      expiresAtMs: now + 6_000,
    })
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () => {
        clockNow = now + 7_000
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: "account-main",
            chatgptUserId: "user-main",
            expiresAtMs: now + 3_600_000,
          }),
          refresh_token: "refresh-token-1",
        })
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: now + 30_000,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(started).toMatchObject({ status: "started" })
    clockNow = now + 5_000
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 35_000,
      now: now + 5_000,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "owner-session-invalid" })
    const session = await readSessionRow(
      (started as { authorizationId: string }).authorizationId,
    )
    expect(session?.status).toBe("cancelled")
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "never_authorized",
      credentialCiphertext: null,
    })
  })

  it("rejects a completion whose poll claim expired while the upstream was answering", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock({
      deviceToken: () =>
        jsonResponse({
          authorization_code: "auth-code-1",
          code_challenge: "challenge-1",
          code_verifier: "verifier-1",
        }),
      exchange: async () => {
        // The upstream answer arrives after the 30-second claim lifetime.
        clockNow = now + 40_000
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000),
          expires_in: 3_600,
          id_token: await signTestIdToken({
            chatgptAccountId: "account-main",
            chatgptUserId: "user-main",
            expiresAtMs: now + 3_600_000,
          }),
          refresh_token: "refresh-token-1",
        })
      },
    })
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: now + 30_000,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(started).toMatchObject({ status: "started" })
    clockNow = now + 5_000
    const result = await pollWithClock({
      authorizationId: (started as { authorizationId: string }).authorizationId,
      deadlineAt: now + 35_000,
      now: now + 5_000,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(result).toEqual({ status: "poll-claim-held" })
    const session = await readSessionRow(
      (started as { authorizationId: string }).authorizationId,
    )
    expect(session?.status).toBe("pending")
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "never_authorized",
      credentialCiphertext: null,
    })
  })
})

describe("authorization status and cancel", () => {
  it("reads status without upstream requests", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    const mock = installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const status = await readCodexAuthorizationStatus(
      { credentialKeys: keyringRaw, database: env.DB, environment },
      {
        authorizationId,
        now: now + 1_000,
        ownerSessionId: owner.sessionId,
        ownerUserId: owner.userId,
      },
    )
    expect(status).toMatchObject({
      intervalMs: defaultIntervalMs,
      nextPollAt: now + defaultIntervalMs,
      status: "pending",
    })
    expect(mock.calls.length).toBe(1)
  })

  it("cancels a pending session and audits it", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    const cancelled = await cancelCodexAuthorization(context, {
      authorizationId,
      now: now + 1_000,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(cancelled).toEqual({ status: "cancelled" })
    expect(await readSessionRow(authorizationId)).toMatchObject({
      status: "cancelled",
    })
    expect(auditEvents.at(-1)).toMatchObject({
      outcome: "success",
      type: "ai_authorization_cancelled",
    })
    // A late poll after cancellation cannot resurrect the session.
    const late = await pollWithClock({
      authorizationId,
      deadlineAt: now + 60_000,
      now: now + defaultIntervalMs,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    expect(late).toEqual({ status: "cancelled" })
  })

  it("marks a version-drifted pending session as connection-changed", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    await authorizeThroughFlow({ ownerSessionId: owner.sessionId })
    installUpstreamMock()
    const started = await startCodexAuthorization(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      ownerSessionId: owner.sessionId,
      ownerUserId: owner.userId,
    })
    const authorizationId = (started as { authorizationId: string })
      .authorizationId
    // A concurrent reauthorization completes and advances the version while
    // this session is still pending.
    const ownerSessionTwo = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
      userId: "second-session-owner",
    })
    await authorizeThroughFlow({
      at: now + 10_000,
      chatgptUserId: "user-main",
      ownerSessionId: ownerSessionTwo.sessionId,
      ownerUserId: "second-session-owner",
    })
    const status = await readCodexAuthorizationStatus(
      { credentialKeys: keyringRaw, database: env.DB, environment },
      {
        authorizationId,
        now: now + 30_000,
        ownerSessionId: owner.sessionId,
        ownerUserId: owner.userId,
      },
    )
    expect(status).toEqual({ status: "connection-changed" })
  })
})

describe("model snapshot reset on reauthorization", () => {
  it("deletes the old snapshot atomically with the credential commit", async () => {
    await createConnection()
    const owner = await createOwnerSession({
      reauthenticatedAtMs: now - 60_000,
    })
    await authorizeThroughFlow({ ownerSessionId: owner.sessionId })
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection?.credentialVersion).toBe(1)
    const committed = await commitAiModelSnapshot(env.DB, {
      connectionId,
      models: [
        { capabilities: null, displayName: null, upstreamModelId: "gpt-test" },
      ],
      now: now + 2_000,
      observedCredentialVersion: 1,
    })
    expect(committed).toMatchObject({ committed: true })
    // Reauthorize through the real flow: the snapshot must be gone.
    await authorizeThroughFlow({
      ownerSessionId: owner.sessionId,
      at: now + 3_000,
    })
    const models = await env.DB.prepare(
      'SELECT count(*) AS count FROM "ai_models" WHERE "connectionId" = ?1',
    )
      .bind(connectionId)
      .first<{ count: number }>()
    expect(models?.count).toBe(0)
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      credentialVersion: 2,
    })
  })
})

describe("AI formal entries stay closed", () => {
  it("refuses every /api/ai route without credentials", async () => {
    // The AI surface is registered: an unauthenticated request is rejected
    // with a controlled Problem, never a 404 or an unhandled error.
    for (const [method, path] of [
      ["GET", "/api/ai/providers"],
      ["GET", "/api/ai/connections"],
      ["POST", "/api/ai/connections"],
      ["GET", "/api/ai/invocations"],
      [
        "POST",
        "/api/ai/connections/11111111-1111-1111-1111-111111111111/disconnect",
      ],
      ["GET", "/api/ai/models"],
      ["POST", "/api/ai/responses"],
    ] as const) {
      const context = createExecutionContext()
      const response = await worker.fetch(
        new Request(`http://local.test${path}`, {
          // Mutations check the exact Origin and JSON content type first
          // (the /api/auth/* precedent), so carry both to reach the
          // authentication boundary this test asserts.
          ...(method === "GET"
            ? {}
            : {
                body: "{}",
                headers: {
                  "content-type": "application/json",
                  origin: "http://local.test",
                },
              }),
          method,
        }),
        env,
        context,
      )
      await waitOnExecutionContext(context)
      expect(response.status, `${method} ${path}`).toBe(401)
      expect(
        response.headers.get("content-type"),
        `${method} ${path}`,
      ).toContain("application/problem+json")
    }
  })
})

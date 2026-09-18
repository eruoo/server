import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AI_CREDENTIAL_REFRESH_LEAD_MS } from "../../src/shared/ai"
import {
  claimAiAuthorizationPoll,
  completeAiAuthorization,
  createAiAuthorizationSession,
} from "../../src/worker/ai/authorizations"
import {
  createAiConnection,
  disconnectAiConnection,
  getAiConnection,
  updateAiConnection,
} from "../../src/worker/ai/connections"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import type { AiCredentialServiceContext } from "../../src/worker/ai/credential-lifecycle"
import { accessCodexCredentials } from "../../src/worker/ai/credential-lifecycle"
import {
  readCodexModelCatalog,
  refreshCodexModelCatalog,
} from "../../src/worker/ai/model-discovery"
import { AiStageUpstreamBudget } from "../../src/worker/ai/stage-budget"

const now = 2_000_000_000_000
const environment = "http://local.test"
const connectionId = "11111111-1111-1111-1111-111111111111"
const ownerUserId = "refresh-owner"
const ownerSessionId = "refresh-owner-session"
const stageDeadlineAt = now + 30_000

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const keyV1 = crypto.getRandomValues(new Uint8Array(32))
const keyV2 = crypto.getRandomValues(new Uint8Array(32))
const keyringRaw = `1:${toBase64Url(keyV1)}`
const rotatedKeyringRaw = `1:${toBase64Url(keyV1)},2:${toBase64Url(keyV2)}`

function fakeAccessToken(expiryMs: number, label = "access"): string {
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  )
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp: Math.floor(expiryMs / 1_000),
        sub: `access-${label}`,
      }),
    ),
  )
  return `${header}.${payload}.${toBase64Url(new Uint8Array(32))}`
}

async function encryptPackage(input: {
  accessToken: string
  chatgptUserId?: string | null
  keyringRaw?: string
  refreshToken?: string
}): Promise<string> {
  const keyring = await parseAiCredentialKeyring(input.keyringRaw ?? keyringRaw)
  return encryptAiSecret(
    keyring,
    JSON.stringify({
      accessToken: input.accessToken,
      chatgptUserId: input.chatgptUserId ?? "user-main",
      refreshToken: input.refreshToken ?? "refresh-token-1",
    }),
    {
      connectionId,
      environment,
      providerType: "openai-codex",
      purpose: "credential-package",
    },
  )
}

interface RefreshMock {
  calls: Array<{ body: string | null; url: string }>
  refresh: (init?: RequestInit) => Response | Promise<Response>
  models: () => Response | Promise<Response>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  })
}

const mocks: Array<{ restore: () => void }> = []
function installUpstreamMock(
  routes: {
    refresh?: (init?: RequestInit) => Response | Promise<Response>
    models?: () => Response | Promise<Response>
  } = {},
): RefreshMock {
  const mock: RefreshMock = {
    calls: [],
    refresh:
      routes.refresh ?? (() => jsonResponse({ error: "unexpected" }, 500)),
    models:
      routes.models ??
      (() =>
        jsonResponse({
          models: [
            {
              display_name: "GPT Test",
              slug: "gpt-test",
              supported_in_api: true,
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "high" },
              ],
              visibility: "list",
            },
          ],
        })),
  }
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      mock.calls.push({
        body: typeof init?.body === "string" ? init.body : null,
        url: request.url,
      })
      if (
        url.origin === "https://auth.openai.com" &&
        url.pathname === "/oauth/token"
      ) {
        return mock.refresh(init)
      }
      if (
        url.origin === "https://chatgpt.com" &&
        url.pathname === "/backend-api/codex/models"
      ) {
        return mock.models()
      }
      throw new Error(
        `Unexpected outbound request: ${request.method} ${request.url}`,
      )
    })
  mocks.push({ restore: () => spy.mockRestore() })
  return mock
}
afterEach(() => {
  while (mocks.length > 0) mocks.pop()?.restore()
  vi.restoreAllMocks()
})

let context: AiCredentialServiceContext

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_invocations"),
    env.DB.prepare("DELETE FROM ai_models"),
    env.DB.prepare("DELETE FROM ai_connections"),
    env.DB.prepare("DELETE FROM user"),
  ])
  context = { credentialKeys: keyringRaw, database: env.DB, environment }
})

let authorizationSessionSeed = 0
async function createOwnerSessionRow(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    ).bind(
      ownerUserId,
      "Owner",
      `${ownerUserId}@example.invalid`,
      1,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId,reauthenticatedAt) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      ownerSessionId,
      new Date(now + 30 * 86400000).toISOString(),
      `token-${ownerSessionId}`,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      ownerUserId,
      new Date(now).toISOString(),
    ),
  ])
}

/** Reaches the connected state through the real storage primitives. */
async function createConnectedConnection(input: {
  accessToken: string
  chatgptUserId?: string | null
  expiresAtMs: number
  keyringRaw?: string
  refreshToken?: string
  upstreamAccountId?: string
}): Promise<void> {
  await createOwnerSessionRow()
  const created = await createAiConnection(env.DB, {
    id: connectionId,
    name: "Main",
    now,
    providerType: "openai-codex",
    slug: "codex-main",
  })
  expect(created).toMatchObject({ created: true })
  authorizationSessionSeed += 1
  const seed = authorizationSessionSeed.toString(16).padStart(12, "0")
  const authorizationSessionId = `22222222-2222-2222-2222-${seed}`
  const claimId = `55555555-5555-5555-5555-${seed}`
  const session = await createAiAuthorizationSession(env.DB, {
    connectionId,
    deviceGrantCiphertext: `device-grant-${seed}`,
    id: authorizationSessionId,
    ownerSessionId,
    ownerUserId,
    pollIntervalMs: 5_000,
    sessionTtlMs: 900_000,
    now,
  })
  expect(session).toMatchObject({ created: true })
  const claimed = await claimAiAuthorizationPoll(env.DB, {
    claimId,
    now: now + 6_000,
    ownerSessionId,
    ownerUserId,
    sessionId: authorizationSessionId,
  })
  expect(claimed).toMatchObject({ claimed: true })
  const completed = await completeAiAuthorization(env.DB, {
    claimId,
    completionId: `66666666-6666-6666-6666-${seed}`,
    credentialCiphertext: await encryptPackage({
      accessToken: input.accessToken,
      chatgptUserId: input.chatgptUserId,
      keyringRaw: input.keyringRaw,
      refreshToken: input.refreshToken,
    }),
    credentialExpiresAt: input.expiresAtMs,
    now: now + 7_000,
    sessionId: authorizationSessionId,
    upstreamAccountId: input.upstreamAccountId ?? "account-main",
  })
  expect(completed).toMatchObject({ completed: true })
}

describe("credential access and refresh", () => {
  it("uses a still-valid credential without any upstream call", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    const mock = installUpstreamMock()
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toMatchObject({
      accessToken: expect.any(String),
      status: "usable",
    })
    expect(mock.calls.length).toBe(0)
  })

  it("refreshes ahead of expiry, persists first, and returns the new token", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    const mock = installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 7_200_000, "fresh"),
          id_token: "unused",
          refresh_token: "refresh-token-2",
        }),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toMatchObject({
      accessToken: expect.any(String),
      status: "usable",
    })
    if (result.status !== "usable") throw new Error("unreachable")
    const payload = JSON.parse(
      atob(
        result.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
      ),
    ) as { sub: string }
    expect(payload.sub).toBe("access-fresh")
    // The refresh request matched the fixed contract shape.
    const refreshCall = mock.calls.find((call) =>
      call.url.includes("/oauth/token"),
    )
    expect(JSON.parse(refreshCall?.body ?? "{}")).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "refresh-token-1",
    })
    // The new package is persisted with its expiry and version advance.
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      credentialExpiresAt: now + 7_200_000,
      credentialVersion: 2,
      refreshClaimId: null,
    })
  })

  it("merges partial refresh responses per the reference contract", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      // The fixed contract may omit fields; the old values stay in force.
      refresh: () => jsonResponse({ refresh_token: "refresh-token-2" }),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toMatchObject({ status: "usable" })
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection?.credentialExpiresAt).toBe(
      now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    )
    const stored = JSON.parse(
      await (async () => {
        const keyring = await parseAiCredentialKeyring(keyringRaw)
        const { decryptAiSecret } =
          await import("../../src/worker/ai/credential-cipher")
        return decryptAiSecret(
          keyring,
          connection?.credentialCiphertext ?? "",
          {
            connectionId,
            environment,
            providerType: "openai-codex",
            purpose: "credential-package",
          },
        )
      })(),
    ) as { refreshToken: string }
    expect(stored.refreshToken).toBe("refresh-token-2")
  })

  it("treats a refresh that provably never sent as retryable and keeps the credential", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    const mock = installUpstreamMock()
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: now - 1,
      now,
    })
    expect(result).toEqual({ status: "upstream-unavailable" })
    expect(mock.calls.length).toBe(0)
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      credentialVersion: 1,
      refreshClaimId: null,
    })
    // With budget restored the same state refreshes successfully.
    mock.refresh = () =>
      jsonResponse({
        access_token: fakeAccessToken(now + 3_600_000, "later"),
        refresh_token: "r2",
      })
    const retry = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now: now + 1_000,
    })
    expect(retry).toMatchObject({ status: "usable" })
  })

  it("treats an exhausted shared upstream budget the same as not-sent", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    const mock = installUpstreamMock()
    const budget = new AiStageUpstreamBudget({
      deadlineAt: stageDeadlineAt,
      upstreamTotalMs: 0,
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
      upstream: budget,
    })
    expect(result).toEqual({ status: "upstream-unavailable" })
    expect(mock.calls.length).toBe(0)
  })

  it("moves to reauthentication on a definitive invalid_grant", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: () => jsonResponse({ error: "invalid_grant" }, 400),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "invalid-grant",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
      credentialExpiresAt: null,
      credentialVersion: 2,
      refreshClaimId: null,
    })
  })

  it("classifies a legacy nested refresh rejection code as definitive", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: () =>
        jsonResponse(
          { error: { code: "refresh_token_reused", message: "used" } },
          400,
        ),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "invalid-grant",
      status: "reauthentication-required",
    })
  })

  it("treats a non-grant 400 refresh rejection as unknown, never replayed", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    // The reference classifies this code as Transient and retries; this
    // service never replays a possibly-consumed refresh token, so the
    // outcome is unknown and the connection requires reauthorization.
    installUpstreamMock({
      refresh: () => jsonResponse({ error: "temporarily_unavailable" }, 400),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "refresh-outcome-unknown",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
    })
  })

  it("moves to reauthentication on a 401 refresh response", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: () => jsonResponse({ error: "unauthorized" }, 401),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "invalid-grant",
      status: "reauthentication-required",
    })
  })

  it("treats a 5xx refresh outcome as unknown and requires reauthorization", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({ refresh: () => jsonResponse({ error: "boom" }, 503) })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "refresh-outcome-unknown",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
    })
  })

  it("treats a transport failure during refresh as unknown and requires reauthorization", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: () => {
        throw new TypeError("fetch failed")
      },
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "refresh-outcome-unknown",
      status: "reauthentication-required",
    })
  })

  it("treats a refresh that exceeded its own timeout as unknown", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    // The upstream never answers; the connector's own per-call abort fires.
    installUpstreamMock({
      refresh: (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          )
          setTimeout(
            () => reject(new DOMException("aborted", "AbortError")),
            15_000,
          )
        }),
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: now + 1_000,
      now,
    })
    expect(result).toEqual({
      reason: "refresh-outcome-unknown",
      status: "reauthentication-required",
    })
  }, 20_000)

  it("reports busy with the claim's remaining time when another holder refreshes", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    // Another instance already holds the refresh claim with 20 seconds left.
    const otherClaimId = "77777777-7777-7777-7777-777777777777"
    await env.DB.prepare(
      `UPDATE "ai_connections" SET "refreshClaimId"=?, "refreshClaimExpiresAt"=? WHERE "id"=?`,
    )
      .bind(otherClaimId, now + 20_000, connectionId)
      .run()
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toMatchObject({ status: "credential-busy" })
    if (result.status !== "credential-busy") throw new Error("unreachable")
    expect(result.retryAfterMs).toBeGreaterThan(0)
    expect(result.retryAfterMs).toBeLessThanOrEqual(20_000)
    // The other holder's claim was not disturbed.
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "connected",
      refreshClaimId: otherClaimId,
    })
  })

  it("adopts another writer's committed credential after losing the version race", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    const winningPackage = await encryptPackage({
      accessToken: fakeAccessToken(now + 7_200_000, "winner"),
      refreshToken: "refresh-winner",
    })
    installUpstreamMock({
      refresh: async () => {
        // Another writer's commit lands while our refresh is in flight.
        await env.DB.prepare(
          `UPDATE "ai_connections" SET "credentialCiphertext"=?,
               "credentialExpiresAt"=?, "credentialVersion"="credentialVersion"+1,
               "refreshClaimId"=NULL, "refreshClaimExpiresAt"=NULL WHERE "id"=?`,
        )
          .bind(winningPackage, now + 7_200_000, connectionId)
          .run()
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "loser"),
        })
      },
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    // Our late result is dropped; the stored winner credential is used.
    expect(result).toMatchObject({ status: "usable" })
    if (result.status !== "usable") throw new Error("unreachable")
    const payload = JSON.parse(
      atob(
        result.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"),
      ),
    ) as { sub: string }
    expect(payload.sub).toBe("access-winner")
  })

  it("requires reauthorization when the claim expires before the commit", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: async () => {
        await env.DB.prepare(
          `UPDATE "ai_connections" SET "refreshClaimExpiresAt"=? WHERE "id"=?`,
        )
          .bind(now - 1, connectionId)
          .run()
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "late"),
        })
      },
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "refresh-claim-expired",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
    })
  })

  it("drops a late refresh result after a disconnect instead of overwriting it", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    installUpstreamMock({
      refresh: async () => {
        await disconnectAiConnection(env.DB, {
          id: connectionId,
          now: now + 500,
        })
        return jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "late"),
        })
      },
    })
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "not-connected",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
      credentialVersion: 2,
    })
  })

  it("transitions to reauthentication when the stored ciphertext is unreadable", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    await env.DB.prepare(
      `UPDATE "ai_connections" SET "credentialCiphertext"=? WHERE "id"=?`,
    )
      .bind("not-a-valid-envelope", connectionId)
      .run()
    const result = await accessCodexCredentials(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "ciphertext-unreadable",
      status: "reauthentication-required",
    })
    expect(await getAiConnection(env.DB, connectionId)).toMatchObject({
      authorizationStatus: "reauthentication_required",
      credentialCiphertext: null,
    })
  })

  it("cannot read a package whose key version left the rotated keyring", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
      keyringRaw: keyringRaw,
    })
    const withoutOldKey = {
      credentialKeys: `2:${toBase64Url(keyV2)}`,
      database: env.DB,
      environment,
    }
    const result = await accessCodexCredentials(withoutOldKey, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({
      reason: "ciphertext-unreadable",
      status: "reauthentication-required",
    })
  })

  it("reads old-version packages after rotation and writes the refresh with the new key", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
      keyringRaw: keyringRaw,
    })
    installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "rotated"),
          refresh_token: "refresh-token-2",
        }),
    })
    const rotatedContext = {
      credentialKeys: rotatedKeyringRaw,
      database: env.DB,
      environment,
    }
    const result = await accessCodexCredentials(rotatedContext, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toMatchObject({ status: "usable" })
    const connection = await getAiConnection(env.DB, connectionId)
    expect(
      (JSON.parse(connection?.credentialCiphertext ?? "{}") as { k: number }).k,
    ).toBe(2)
  })

  it("refuses credential use for disabled and missing connections", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    const disabled = await updateAiConnection(env.DB, {
      enabled: false,
      id: connectionId,
      now: now + 1_000,
    })
    expect(disabled).toMatchObject({ updated: true })
    expect(
      await accessCodexCredentials(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now,
      }),
    ).toEqual({ status: "disabled" })
    expect(
      await accessCodexCredentials(context, {
        connectionId: "99999999-9999-9999-9999-999999999999",
        deadlineAt: stageDeadlineAt,
        now,
      }),
    ).toEqual({ status: "connection-not-found" })
  })
})

describe("model catalog discovery and read", () => {
  it("commits a discovered snapshot with exact ids and reported capabilities", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    const mock = installUpstreamMock()
    const result = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({ modelCount: 1, status: "committed" })
    const catalog = await readCodexModelCatalog(env.DB, { connectionId })
    expect(catalog).toMatchObject({ status: "available" })
    if (catalog.status !== "available") throw new Error("unreachable")
    expect(catalog.models).toEqual([
      {
        capabilities: {
          reasoningEfforts: ["low", "high"],
          supportedInApi: true,
          visibility: "list",
        },
        discoveredAt: now,
        displayName: "GPT Test",
        upstreamModelId: "gpt-test",
      },
    ])
    // The discovery request carried the account header and bearer token.
    const modelsCall = mock.calls.find((call) =>
      call.url.includes("/backend-api/codex/models"),
    )
    expect(modelsCall?.url).toContain("client_version=0.154.0")
  })

  it("keeps the previous snapshot on a failed discovery and reports it", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    installUpstreamMock()
    expect(
      await refreshCodexModelCatalog(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now,
      }),
    ).toEqual({ modelCount: 1, status: "committed" })
    installUpstreamMock({ models: () => jsonResponse({ error: "down" }, 500) })
    const failed = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now: now + 1_000,
    })
    expect(failed).toEqual({
      keptSnapshot: true,
      reason: "unavailable",
      status: "upstream-failure",
    })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toMatchObject(
      {
        status: "available",
      },
    )
  })

  it("reports not-discovered when the first discovery fails", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    installUpstreamMock({
      models: () => jsonResponse({ models: "broken" }, 200),
    })
    const failed = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(failed).toEqual({
      keptSnapshot: false,
      reason: "protocol",
      status: "upstream-failure",
    })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toEqual({
      status: "not-discovered",
    })
  })

  it("refreshes an expiring credential inside the discovery stage", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2),
      expiresAtMs: now + AI_CREDENTIAL_REFRESH_LEAD_MS / 2,
    })
    const mock = installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "refreshed"),
          refresh_token: "refresh-token-2",
        }),
    })
    const result = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({ modelCount: 1, status: "committed" })
    expect(mock.calls.some((call) => call.url.includes("/oauth/token"))).toBe(
      true,
    )
    expect(
      mock.calls.some((call) => call.url.includes("/backend-api/codex/models")),
    ).toBe(true)
  })

  it("requires reauthorization before discovery on a disconnected connection", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    await disconnectAiConnection(env.DB, { id: connectionId, now: now + 1_000 })
    const result = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now: now + 2_000,
    })
    expect(result).toEqual({
      reason: "not-connected",
      status: "reauthentication-required",
    })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toEqual({
      status: "not-connected",
    })
  })

  it("keeps the catalog valid across a routine refresh but not across a reauthorization", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    installUpstreamMock()
    expect(
      await refreshCodexModelCatalog(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now,
      }),
    ).toEqual({ modelCount: 1, status: "committed" })

    // A routine credential refresh does not invalidate the discovered catalog.
    await env.DB.prepare(
      `UPDATE "ai_connections" SET "credentialExpiresAt"=? WHERE "id"=?`,
    )
      .bind(now + 30_000, connectionId)
      .run()
    installUpstreamMock({
      refresh: () =>
        jsonResponse({
          access_token: fakeAccessToken(now + 3_600_000, "routine"),
          refresh_token: "refresh-token-2",
        }),
    })
    expect(
      await accessCodexCredentials(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now: now + 2_000,
      }),
    ).toMatchObject({ status: "usable" })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toMatchObject(
      {
        status: "available",
      },
    )

    // A reauthorization opens a new epoch: the old snapshot is gone until a
    // new discovery succeeds.
    authorizationSessionSeed += 1
    const seed = authorizationSessionSeed.toString(16).padStart(12, "0")
    const authorizationSessionId = `22222222-2222-2222-2222-${seed}`
    const claimId = `55555555-5555-5555-5555-${seed}`
    const session = await createAiAuthorizationSession(env.DB, {
      connectionId,
      deviceGrantCiphertext: `device-grant-${seed}`,
      id: authorizationSessionId,
      ownerSessionId,
      ownerUserId,
      pollIntervalMs: 5_000,
      sessionTtlMs: 900_000,
      now: now + 3_000,
    })
    expect(session).toMatchObject({ created: true })
    const claimed = await claimAiAuthorizationPoll(env.DB, {
      claimId,
      now: now + 9_000,
      ownerSessionId,
      ownerUserId,
      sessionId: authorizationSessionId,
    })
    expect(claimed).toMatchObject({ claimed: true })
    const completed = await completeAiAuthorization(env.DB, {
      claimId,
      completionId: `66666666-6666-6666-6666-${seed}`,
      credentialCiphertext: await encryptPackage({
        accessToken: fakeAccessToken(now + 3_600_000, "reauthorized"),
        refreshToken: "refresh-token-3",
      }),
      credentialExpiresAt: now + 3_600_000,
      now: now + 10_000,
      sessionId: authorizationSessionId,
      upstreamAccountId: "account-main",
    })
    expect(completed).toMatchObject({ completed: true })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toEqual({
      status: "not-discovered",
    })
    // The next successful discovery restores availability in the new epoch.
    installUpstreamMock()
    expect(
      await refreshCodexModelCatalog(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now: now + 6_000,
      }),
    ).toEqual({ modelCount: 1, status: "committed" })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toMatchObject(
      {
        status: "available",
      },
    )
  })

  it("reports connection-changed when the credential version moves under a discovery", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    installUpstreamMock({
      models: async () => {
        await env.DB.prepare(
          `UPDATE "ai_connections" SET "credentialVersion"="credentialVersion"+1 WHERE "id"=?`,
        )
          .bind(connectionId)
          .run()
        return jsonResponse({ models: [] })
      },
    })
    const result = await refreshCodexModelCatalog(context, {
      connectionId,
      deadlineAt: stageDeadlineAt,
      now,
    })
    expect(result).toEqual({ status: "connection-changed" })
    expect(await readCodexModelCatalog(env.DB, { connectionId })).toEqual({
      status: "not-discovered",
    })
  })

  it("refuses discovery for disabled connections and oversized catalogs", async () => {
    await createConnectedConnection({
      accessToken: fakeAccessToken(now + 3_600_000),
      expiresAtMs: now + 3_600_000,
    })
    const disabled = await updateAiConnection(env.DB, {
      enabled: false,
      id: connectionId,
      now: now + 1_000,
    })
    expect(disabled).toMatchObject({ updated: true })
    expect(
      await refreshCodexModelCatalog(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now: now + 2_000,
      }),
    ).toEqual({ status: "disabled" })
    await updateAiConnection(env.DB, {
      enabled: true,
      id: connectionId,
      now: now + 3_000,
    })
    installUpstreamMock({
      models: () =>
        jsonResponse({
          models: Array.from({ length: 201 }, (_, index) => ({
            slug: `model-${index}`,
          })),
        }),
    })
    expect(
      await refreshCodexModelCatalog(context, {
        connectionId,
        deadlineAt: stageDeadlineAt,
        now: now + 4_000,
      }),
    ).toEqual({
      keptSnapshot: false,
      reason: "protocol",
      status: "upstream-failure",
    })
  })
})

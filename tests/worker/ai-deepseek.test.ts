import { env } from "cloudflare:test"
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"

import { cleanupExpiredAiState } from "../../src/worker/ai/cleanup"
import {
  createAiConnection,
  disconnectAiConnection,
  getAiConnection,
} from "../../src/worker/ai/connections"
import {
  saveDeepSeekCredential,
  accessDeepSeekCredentials,
  markAiCredentialInvalid,
} from "../../src/worker/ai/credential-lifecycle"
import { deepSeekModelCapabilities } from "../../src/worker/ai/deepseek-connector"
import {
  buildAiKeyPermissions,
  listAiAuthorizedModels,
  resolveAiModelSelection,
  validateAiRequestCapabilities,
} from "../../src/worker/ai/model-authorization"
import { refreshDeepSeekModelCatalog } from "../../src/worker/ai/model-discovery"
import { listAiModels } from "../../src/worker/ai/models"
import { validateResponsesRequest } from "../../src/worker/ai/responses-request"
import { ownerSession } from "./fixtures/session"

const connectionId = "11111111-1111-4111-8111-111111111111"
const context = {
  database: env.DB,
  credentialKeys: env.AI_CREDENTIAL_KEYS,
  environment: env.APP_ORIGIN,
}
let owner: { subject: string; sessionId: string }
function save(
  apiKey = "synthetic-first-key",
  expectedVersion = 0,
  database = env.DB,
) {
  return saveDeepSeekCredential(
    { ...context, database },
    {
      connectionId,
      apiKey,
      expectedVersion,
      owner,
      ownerGitHubId: env.OWNER_GITHUB_ID,
    },
  )
}
async function discover() {
  return refreshDeepSeekModelCatalog(context, {
    connectionId,
    requestId: crypto.randomUUID(),
    now: Date.now(),
    deadlineAt: Date.now() + 30000,
  })
}
function modelsResponse() {
  return Response.json({
    data: [
      { id: "deepseek-flash" },
      { id: "deepseek-v4-pro" },
      { id: "unknown-future-model" },
    ],
  })
}
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS synthetic_key_commit_failure"),
    ...[
      "ai_invocations",
      "ai_models",
      "ai_connections",
      "session",
      "account",
      "apikey",
      "user",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  ])
  const session = await ownerSession()
  owner = { subject: session.id, sessionId: session.id }
  await createAiConnection(env.DB, {
    id: connectionId,
    name: "DeepSeek",
    slug: "main",
    providerType: "deepseek",
    now: Date.now(),
  })
})
afterEach(() => vi.restoreAllMocks())

describe("DeepSeek credentials and permissions", () => {
  it("encrypts a static key without expiration or refresh and makes no upstream call on save", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    expect(await save()).toBe("saved")
    expect(fetch).not.toHaveBeenCalled()
    const connection = await getAiConnection(env.DB, connectionId)
    expect(connection).toMatchObject({
      authorizationStatus: "connected",
      credentialVersion: 1,
      permissionVersion: 0,
    })
    expect(JSON.stringify(connection)).not.toContain("synthetic-first-key")
    expect(connection).not.toHaveProperty("credentialExpiresAt")
    expect(
      await accessDeepSeekCredentials(context, {
        connectionId,
        deadlineAt: Date.now() + 1000,
      }),
    ).toMatchObject({ status: "usable", apiKey: "synthetic-first-key" })
  })
  it.each(["revoked", "expired", "wrong-owner", "owner-unlinked"])(
    "refuses a key write with %s persistent session",
    async (state) => {
      if (state === "revoked")
        await env.DB.prepare("DELETE FROM session WHERE id=?")
          .bind(owner.sessionId)
          .run()
      if (state === "expired")
        await env.DB.prepare("UPDATE session SET expiresAt=? WHERE id=?")
          .bind(new Date(Date.now() - 1000).toISOString(), owner.sessionId)
          .run()
      if (state === "wrong-owner")
        owner = { ...owner, subject: "different-owner" }
      if (state === "owner-unlinked")
        await env.DB.prepare("DELETE FROM account").run()
      expect(await save()).toBe("invalid-session")
      expect(
        (await getAiConnection(env.DB, connectionId))?.credentialVersion,
      ).toBe(0)
    },
  )
  it("checks session validity inside the commit after encryption", async () => {
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("DELETE FROM session WHERE id=?")
              .bind(owner.sessionId)
              .run()
            return target.batch(statements)
          }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    expect(await save("synthetic", 0, database)).toBe("invalid-session")
    expect(
      (await getAiConnection(env.DB, connectionId))?.credentialCiphertext,
    ).toBeNull()
  })
  it("has one winner for concurrent saves and keeps the winning version", async () => {
    const results = await Promise.all([
      save("synthetic-one"),
      save("synthetic-two"),
    ])
    expect(results.sort()).toEqual(["conflict", "saved"])
    expect(
      (await getAiConnection(env.DB, connectionId))?.credentialVersion,
    ).toBe(1)
  })
  it("rolls back snapshot deletion when the credential write fails", async () => {
    await save()
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      modelsResponse(),
    )
    await discover()
    await env.DB.prepare(
      "CREATE TRIGGER synthetic_key_commit_failure BEFORE UPDATE ON ai_connections BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    ).run()
    await expect(save("replacement", 1)).rejects.toThrow("synthetic failure")
    expect((await listAiModels(env.DB, connectionId)).length).toBe(3)
    expect(
      (await getAiConnection(env.DB, connectionId))?.credentialVersion,
    ).toBe(1)
  })
  it("preserves grants on key replacement, requires fresh discovery, and revokes grants permanently on disconnect", async () => {
    await save()
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      modelsResponse(),
    )
    await discover()
    const selected = await resolveAiModelSelection(env.DB, [
      "main/deepseek-flash",
    ])
    if (!selected.ok) throw new Error("Expected selectable model")
    const grants = buildAiKeyPermissions(selected.entries)
    expect(await listAiAuthorizedModels(env.DB, grants)).toHaveLength(1)
    expect(await save("replacement", 1)).toBe("saved")
    expect(await listAiAuthorizedModels(env.DB, grants)).toHaveLength(0)
    await discover()
    expect(await listAiAuthorizedModels(env.DB, grants)).toHaveLength(1)
    await disconnectAiConnection(env.DB, { id: connectionId, now: Date.now() })
    expect(await save("third-key", 3)).toBe("saved")
    await discover()
    expect(await listAiAuthorizedModels(env.DB, grants)).toHaveLength(0)
    const current = await resolveAiModelSelection(env.DB, [
      "main/deepseek-flash",
    ])
    if (!current.ok) throw new Error("Expected selectable model")
    expect(
      await listAiAuthorizedModels(
        env.DB,
        buildAiKeyPermissions(current.entries),
      ),
    ).toHaveLength(1)
  })
  it("does not let a late 401 invalidate a newer key", async () => {
    await save()
    await save("new-key", 1)
    await markAiCredentialInvalid(env.DB, connectionId, 1)
    expect(
      (await getAiConnection(env.DB, connectionId))?.authorizationStatus,
    ).toBe("connected")
  })
  it("does not erase stored credentials when the deployment encryption key is unavailable", async () => {
    await save()
    expect(
      await accessDeepSeekCredentials(
        { ...context, credentialKeys: "" },
        { connectionId, deadlineAt: Date.now() + 1000 },
      ),
    ).toMatchObject({ status: "upstream-unavailable" })
    expect(
      (await getAiConnection(env.DB, connectionId))?.authorizationStatus,
    ).toBe("connected")
  })
})

describe("DeepSeek discovery and capability contract", () => {
  it("uses the official model endpoint and leaves unknown capabilities unconfirmed", async () => {
    await save()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => modelsResponse())
    expect(await discover()).toEqual({ status: "committed", modelCount: 3 })
    expect(fetch.mock.calls[0][0]).toBe("https://api.deepseek.com/models")
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer synthetic-first-key")
    expect(
      await resolveAiModelSelection(env.DB, ["main/unknown-future-model"]),
    ).toMatchObject({ ok: false })
    expect(deepSeekModelCapabilities("deepseek-flash")).toMatchObject({
      vision: true,
      reasoningEfforts: ["none", "low", "high", "max"],
      defaultReasoningEffort: "max",
    })
    expect(deepSeekModelCapabilities("deepseek-v4-pro").vision).toBe(false)
  })
  it.each([
    [401, "ai-reauthorization-required"],
    [402, "ai-upstream-quota-exceeded"],
    [429, "ai-upstream-rate-limited"],
    [403, "ai-upstream-unavailable"],
    [503, "ai-upstream-unavailable"],
  ] as const)(
    "classifies HTTP %s without refresh or replay",
    async (status, problem) => {
      await save()
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("never expose this", { status }))
      expect(await discover()).toEqual({ status: "failed", problem })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(
        (await getAiConnection(env.DB, connectionId))?.authorizationStatus,
      ).toBe(status === 401 ? "reauthentication_required" : "connected")
    },
  )
  it("keeps a successful snapshot on temporary failure and rejects a late discovery", async () => {
    await save()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => modelsResponse())
    await discover()
    fetch.mockResolvedValue(new Response(null, { status: 503 }))
    await discover()
    expect(await listAiModels(env.DB, connectionId)).toHaveLength(3)
    fetch.mockImplementation(async () => {
      await save("replacement", 1)
      return modelsResponse()
    })
    expect(await discover()).toMatchObject({ status: "failed" })
    expect(await listAiModels(env.DB, connectionId)).toHaveLength(0)
  })
  it("rejects malformed and oversized catalogs", async () => {
    await save()
    const fetch = vi.spyOn(globalThis, "fetch")
    for (const body of [
      { models: [{ slug: "old-shape" }] },
      { data: [{ id: "same" }, { id: "same" }] },
      { data: [{ id: "x".repeat(262145) }] },
    ]) {
      fetch.mockResolvedValue(Response.json(body))
      expect(await discover()).toMatchObject({
        status: "failed",
        problem: "ai-upstream-protocol-error",
      })
    }
  })
  it("allows multimodal requests with max effort only for the confirmed vision model", () => {
    const request = {
      model: "main/deepseek-flash",
      reasoning: { effort: "max" },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
            },
            { type: "input_text", text: "Describe" },
          ],
        },
      ],
    }
    const validated = validateResponsesRequest(request)
    if (!validated.ok) throw new Error("Expected valid multimodal request")
    expect(
      validateAiRequestCapabilities({
        capabilities: JSON.stringify(
          deepSeekModelCapabilities("deepseek-flash"),
        ),
        request: validated.value,
      }),
    ).toEqual({ ok: true })
    expect(
      validateAiRequestCapabilities({
        capabilities: JSON.stringify(
          deepSeekModelCapabilities("deepseek-v4-pro"),
        ),
        request: validated.value,
      }),
    ).toMatchObject({ ok: false, field: "input_image" })
  })
  it("rejects ignored parameters, semantic downgrades and unpaired tool history", () => {
    for (const extra of [
      { include: [] },
      { parallel_tool_calls: false },
      {
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "instruction" }],
          },
        ],
      },
      { tools: [{ type: "function", name: "f", strict: true }] },
      { input: [{ type: "reasoning", encrypted_content: "opaque" }] },
      {
        input: [
          { type: "function_call", name: "f", call_id: "1", arguments: "{}" },
        ],
      },
    ]) {
      expect(
        validateResponsesRequest({
          model: "main/deepseek-flash",
          input: "hello",
          ...extra,
        }).ok,
      ).toBe(false)
    }
  })
  it("cleans invocation retention without referencing retired authorization tables", async () => {
    expect(await cleanupExpiredAiState(env.DB, Date.now())).toEqual({
      deletedInvocations: 0,
    })
  })
})

it("bounds a stalled credential read without starting upstream work", async () => {
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return () => ({ bind: () => ({ first: () => new Promise(() => {}) }) })
      const value = Reflect.get(target, key)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const fetch = vi.spyOn(globalThis, "fetch")
  expect(
    await accessDeepSeekCredentials(
      { ...context, database },
      { connectionId, deadlineAt: Date.now() + 10 },
    ),
  ).toEqual({ status: "timed-out" })
  expect(fetch).not.toHaveBeenCalled()
})

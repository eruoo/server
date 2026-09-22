import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  API_KEY_AI_OPERATIONS,
  apiKeyAiModelPermissionKey,
  formatAiExternalModelId,
  parseAiExternalModelId,
} from "../../src/shared/api-key"
import {
  createAiConnection,
  deleteAiConnection,
  getAiConnection,
} from "../../src/worker/ai/connections"
import {
  encryptAiSecret,
  parseAiCredentialKeyring,
} from "../../src/worker/ai/credential-cipher"
import {
  authorizeAiInvocation,
  authorizeAiModelRead,
  buildAiKeyPermissions,
  listAiAuthorizedModels,
  resolveAiModelSelection,
} from "../../src/worker/ai/model-authorization"
import { commitAiModelSnapshot } from "../../src/worker/ai/models"

const environment = "http://local.test"
const connectionId = "11111111-1111-1111-1111-111111111111"
const secondConnectionId = "99999999-9999-9999-9999-999999999999"
const ownerUserId = "authorization-owner"
const ownerSessionId = "authorization-owner-session"

const keyV1 = crypto.getRandomValues(new Uint8Array(32))
const keyringRaw = `1:${btoa(String.fromCharCode(...keyV1))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "")}`

async function encryptPackage(): Promise<string> {
  const keyring = await parseAiCredentialKeyring(keyringRaw)
  return encryptAiSecret(
    keyring,
    JSON.stringify({
      kind: "api-key",
      apiKey: "access-token-1",
    }),
    {
      connectionId,
      environment,
      providerType: "deepseek",
      purpose: "credential-package",
    },
  )
}

async function createConnectedConnection(input: {
  id: string
  slug: string
  seed: string
}): Promise<void> {
  const now = Date.now()
  const created = await createAiConnection(env.DB, {
    id: input.id,
    name: input.slug,
    now,
    providerType: "deepseek",
    slug: input.slug,
  })
  expect(created).toMatchObject({ created: true })
  await env.DB.prepare(
    "UPDATE ai_connections SET authorizationStatus='connected', credentialCiphertext=?, credentialVersion=1 WHERE id=?",
  )
    .bind(await encryptPackage(), input.id)
    .run()
  const connection = await getAiConnection(env.DB, input.id)
  const snapshot = await commitAiModelSnapshot(env.DB, {
    connectionId: input.id,
    models: [
      {
        capabilities: JSON.stringify({
          supportedInApi: true,
          reasoningEfforts: ["low", "max"],
        }),
        displayName: "GPT Test",
        upstreamModelId: "gpt-test",
      },
      {
        capabilities: JSON.stringify({ supportedInApi: true }),
        displayName: "GPT Other",
        upstreamModelId: "openai/gpt-other",
      },
    ],
    now: now + 8_000,
    observedCredentialVersion: connection?.credentialVersion ?? 1,
  })
  expect(snapshot).toMatchObject({ committed: true })
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_invocations"),
    env.DB.prepare("DELETE FROM ai_models"),
    env.DB.prepare("DELETE FROM ai_connections"),
    env.DB.prepare("DELETE FROM user"),
  ])
  const now = Date.now()
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
      new Date(now + 30 * 86_400_000).toISOString(),
      `token-${ownerSessionId}`,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      ownerUserId,
      new Date(now).toISOString(),
    ),
  ])
  await createConnectedConnection({
    id: connectionId,
    seed: "1",
    slug: "codex-main",
  })
})

describe("AI model authorization", () => {
  it("resolves selected external IDs against the exact catalog", async () => {
    const resolved = await resolveAiModelSelection(env.DB, [
      "codex-main/gpt-test",
      "codex-main/openai/gpt-other",
    ])
    expect(resolved).toEqual({
      entries: [
        {
          connectionId,
          permissionVersion: 0,
          connectionSlug: "codex-main",
          upstreamModelId: "gpt-test",
        },
        {
          connectionId,
          permissionVersion: 0,
          connectionSlug: "codex-main",
          upstreamModelId: "openai/gpt-other",
        },
      ],
      ok: true,
    })
  })

  it("rejects duplicates, malformed IDs, and models outside the catalog", async () => {
    await expect(
      resolveAiModelSelection(env.DB, [
        "codex-main/gpt-test",
        "codex-main/gpt-test",
      ]),
    ).resolves.toEqual({ ok: false, reason: "duplicate-model" })
    await expect(
      resolveAiModelSelection(env.DB, ["codex-main/gpt-test".toUpperCase()]),
    ).resolves.toEqual({ ok: false, reason: "unknown-model" })
    await expect(
      resolveAiModelSelection(env.DB, ["missing-connection/gpt-test"]),
    ).resolves.toEqual({ ok: false, reason: "unknown-model" })
    await expect(
      resolveAiModelSelection(env.DB, ["codex-main/not-in-catalog"]),
    ).resolves.toEqual({ ok: false, reason: "unknown-model" })
    await expect(
      resolveAiModelSelection(env.DB, ["no-slash"]),
    ).resolves.toEqual({
      ok: false,
      reason: "unknown-model",
    })
  })

  it("binds permissions to the connection UUID, sorted and deduplicated", async () => {
    const resolved = await resolveAiModelSelection(env.DB, [
      "codex-main/openai/gpt-other",
      "codex-main/gpt-test",
    ])
    if (!resolved.ok) throw new Error("resolution failed")
    const permissions = buildAiKeyPermissions(resolved.entries)
    expect(permissions).toEqual({
      ai: [...API_KEY_AI_OPERATIONS],
      [apiKeyAiModelPermissionKey(connectionId)]: [
        "gpt-test",
        "openai/gpt-other",
      ],
    })
  })

  it("requires both the invoke operation and the exact model grant", () => {
    const permissions = {
      ai: ["invoke", "models:read"],
      [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test"],
    }
    expect(authorizeAiInvocation(permissions, connectionId, "gpt-test")).toBe(
      true,
    )
    expect(
      authorizeAiInvocation(permissions, connectionId, "openai/gpt-other"),
    ).toBe(false)
    expect(
      authorizeAiInvocation(permissions, secondConnectionId, "gpt-test"),
    ).toBe(false)
    expect(
      authorizeAiInvocation(
        {
          ai: ["models:read"],
          [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test"],
        },
        connectionId,
        "gpt-test",
      ),
    ).toBe(false)
    expect(authorizeAiInvocation(null, connectionId, "gpt-test")).toBe(false)
    expect(authorizeAiModelRead(permissions)).toBe(true)
    expect(authorizeAiModelRead({ ai: ["invoke"] })).toBe(false)
  })

  it("lists only grants that still exist in the current catalog", async () => {
    const permissions = {
      ai: ["invoke", "models:read"],
      [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test", "retired-model"],
      [apiKeyAiModelPermissionKey(secondConnectionId)]: ["gpt-test"],
    }
    const models = await listAiAuthorizedModels(env.DB, permissions)
    expect(models.map((model) => model.externalModelId)).toEqual([
      "codex-main/gpt-test",
    ])
    expect(models[0]).toMatchObject({
      capabilities: { reasoningEfforts: ["low", "max"] },
      connectionId,
      displayName: "GPT Test",
    })
  })

  it("keeps a stale slug grant dead after the connection is recreated", async () => {
    const permissions = {
      ai: ["invoke"],
      [apiKeyAiModelPermissionKey(secondConnectionId)]: ["gpt-test"],
    }
    // The old connection is deleted, then a new one reuses its slug with a
    // different UUID.
    const deleted = await deleteAiConnection(env.DB, { id: connectionId })
    expect(deleted).toMatchObject({ deleted: true })
    await createConnectedConnection({
      id: secondConnectionId,
      seed: "2",
      slug: "codex-main",
    })
    const models = await listAiAuthorizedModels(env.DB, permissions)
    expect(models.map((model) => model.externalModelId)).toEqual([
      "codex-main/gpt-test",
    ])
    // The old UUID grant never resolves against the recreated slug.
    const resolved = await resolveAiModelSelection(env.DB, [
      "codex-main/gpt-test",
    ])
    expect(resolved).toMatchObject({ ok: true })
    if (!resolved.ok) throw new Error("resolution failed")
    expect(resolved.entries[0]?.connectionId).toBe(secondConnectionId)
  })

  it("parses external model IDs without normalizing the upstream part", () => {
    expect(parseAiExternalModelId("codex-main/gpt-test")).toEqual({
      connectionSlug: "codex-main",
      upstreamModelId: "gpt-test",
    })
    expect(parseAiExternalModelId("codex-main/openai/gpt-other")).toEqual({
      connectionSlug: "codex-main",
      upstreamModelId: "openai/gpt-other",
    })
    expect(parseAiExternalModelId("/gpt-test")).toBeNull()
    expect(parseAiExternalModelId("codex-main/")).toBeNull()
    expect(parseAiExternalModelId("codex-main")).toBeNull()
    expect(formatAiExternalModelId("codex-main", "GPT-Test")).toBe(
      "codex-main/GPT-Test",
    )
  })
})

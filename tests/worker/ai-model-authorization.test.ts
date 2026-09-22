import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import {
  API_KEY_AI_OPERATIONS,
  apiKeyAiModelPermissionKey,
  readAiKeyConnectionGrant,
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
  name: string
}): Promise<void> {
  const now = Date.now()
  const created = await createAiConnection(env.DB, {
    id: input.id,
    name: input.name,
    now,
    providerType: "deepseek",
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
    name: "Main",
  })
})

describe("AI model authorization", () => {
  it("resolves native IDs, including slashes, within the selected connection", async () => {
    const resolved = await resolveAiModelSelection(env.DB, connectionId, [
      "gpt-test",
      "openai/gpt-other",
    ])
    expect(resolved).toEqual({
      ok: true,
      selection: {
        connectionId,
        permissionVersion: 0,
        modelIds: ["gpt-test", "openai/gpt-other"],
      },
    })
    if (!resolved.ok) throw new Error("resolution failed")
    expect(buildAiKeyPermissions(resolved.selection)).toEqual({
      ai: [...API_KEY_AI_OPERATIONS],
      [apiKeyAiModelPermissionKey(connectionId)]: [
        "gpt-test",
        "openai/gpt-other",
      ],
    })
  })

  it("rejects duplicate, unknown and formerly prefixed model IDs", async () => {
    await expect(
      resolveAiModelSelection(env.DB, connectionId, ["gpt-test", "gpt-test"]),
    ).resolves.toEqual({ ok: false, reason: "duplicate-model" })
    for (const id of ["GPT-TEST", "codex-main/gpt-test", "not-in-catalog"]) {
      await expect(
        resolveAiModelSelection(env.DB, connectionId, [id]),
      ).resolves.toEqual({ ok: false, reason: "unknown-model" })
    }
    for (const id of ["invalid-id", secondConnectionId]) {
      await expect(
        resolveAiModelSelection(env.DB, id, ["gpt-test"]),
      ).resolves.toEqual({ ok: false, reason: "unknown-connection" })
    }
  })

  it("requires invoke permission and the exact connection, version and model", () => {
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
      authorizeAiInvocation(permissions, connectionId, "gpt-test", 1),
    ).toBe(false)
    expect(
      authorizeAiInvocation(
        { ...permissions, ai: ["models:read"] },
        connectionId,
        "gpt-test",
      ),
    ).toBe(false)
    expect(authorizeAiInvocation(null, connectionId, "gpt-test")).toBe(false)
    expect(authorizeAiModelRead(permissions)).toBe(true)
    expect(authorizeAiModelRead({ ai: ["invoke"] })).toBe(false)
  })

  it("lists only models in the bound connection even when another has the same IDs", async () => {
    await createConnectedConnection({ id: secondConnectionId, name: "Main" })
    const permissions = {
      ai: ["invoke", "models:read"],
      [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test", "retired-model"],
    }
    const models = await listAiAuthorizedModels(env.DB, permissions)
    expect(models.map((model) => model.upstreamModelId)).toEqual(["gpt-test"])
    expect(models[0]).toMatchObject({
      capabilities: { reasoningEfforts: ["low", "max"] },
      connectionId,
      displayName: "GPT Test",
    })
  })

  it("rejects ambiguous old multi-connection grants instead of selecting an upstream", async () => {
    await createConnectedConnection({ id: secondConnectionId, name: "Other" })
    const permissions = {
      ai: ["invoke", "models:read"],
      [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test"],
      [apiKeyAiModelPermissionKey(secondConnectionId)]: ["gpt-test"],
    }
    expect(readAiKeyConnectionGrant(permissions)).toBeNull()
    expect(authorizeAiInvocation(permissions, connectionId, "gpt-test")).toBe(
      false,
    )
    expect(await listAiAuthorizedModels(env.DB, permissions)).toEqual([])
  })

  it("never revives a deleted connection grant when its name and models are reused", async () => {
    const permissions = {
      ai: ["invoke"],
      [apiKeyAiModelPermissionKey(connectionId)]: ["gpt-test"],
    }
    expect(
      await deleteAiConnection(env.DB, { id: connectionId }),
    ).toMatchObject({ deleted: true })
    await createConnectedConnection({ id: secondConnectionId, name: "Main" })
    expect(await listAiAuthorizedModels(env.DB, permissions)).toEqual([])
    expect(
      authorizeAiInvocation(permissions, secondConnectionId, "gpt-test"),
    ).toBe(false)
  })

  it("retains the connection binding when all models are revoked, even while disconnected", async () => {
    await env.DB.prepare(
      "UPDATE ai_connections SET authorizationStatus='never_authorized', credentialCiphertext=NULL WHERE id=?",
    )
      .bind(connectionId)
      .run()
    const resolved = await resolveAiModelSelection(env.DB, connectionId, [])
    if (!resolved.ok) throw new Error("resolution failed")
    const permissions = buildAiKeyPermissions(resolved.selection)
    expect(readAiKeyConnectionGrant(permissions)).toEqual({
      connectionId,
      permissionVersion: 0,
      modelIds: [],
    })
    expect(authorizeAiInvocation(permissions, connectionId, "gpt-test")).toBe(
      false,
    )
    expect(await listAiAuthorizedModels(env.DB, permissions)).toEqual([])
  })

  it("rejects malformed permission scopes", () => {
    for (const scope of [
      `ai-model:${connectionId}`,
      `ai-model:${connectionId}:-1`,
      `ai-model:${connectionId}:01`,
      `ai-model:${connectionId}:0:1`,
    ]) {
      expect(readAiKeyConnectionGrant({ [scope]: ["gpt-test"] })).toBeNull()
    }
    expect(readAiKeyConnectionGrant({ ai: ["invoke"] })).toBeNull()
  })
})

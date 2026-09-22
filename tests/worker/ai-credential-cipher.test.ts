import { describe, it, expect } from "vitest"

import {
  encryptAiSecret,
  decryptAiSecret,
  parseAiCredentialKeyring,
  AiCredentialCipherError,
} from "../../src/worker/ai/credential-cipher"
const environment = "http://local.test",
  connectionId = "11111111-1111-1111-1111-111111111111"
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

describe("AI credential cipher", () => {
  const aad = {
    connectionId,
    environment,
    providerType: "deepseek",
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

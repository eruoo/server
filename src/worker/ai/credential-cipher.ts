import { AI_CREDENTIAL_CIPHERTEXT_MAX_LENGTH } from "./policy"

/**
 * AES-256-GCM envelope encryption for AI upstream secrets.
 *
 * The keyring is the versioned `AI_CREDENTIAL_KEYS` secret in the form
 * `<version>:<base64url 32-byte key>` repeated comma-separated. Decryption
 * selects the key recorded in the envelope, so rotation keeps old ciphertexts
 * readable; new writes always use the current (highest) version.
 *
 * The additional authenticated data binds the deployment environment, the
 * connection UUID, the provider type, and the payload purpose, so a
 * ciphertext copied between connections, environments, or purposes fails
 * authentication instead of decrypting into the wrong context.
 *
 * The secret is parsed on demand per operation and never cached across
 * requests: a missing or invalid keyring only breaks the AI operations that
 * need it, never module initialization or the identity stack.
 */

export type AiCipherPurpose = "credential-package" | "device-grant"

export interface AiCipherAdditionalData {
  connectionId: string
  environment: string
  providerType: string
  purpose: AiCipherPurpose
}

export type AiCredentialCipherErrorKind =
  | "invalid-keyring"
  | "key-not-found"
  | "malformed-envelope"
  | "authentication-failed"

export class AiCredentialCipherError extends Error {
  readonly kind: AiCredentialCipherErrorKind
  constructor(kind: AiCredentialCipherErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = "AiCredentialCipherError"
  }
}

const AI_CIPHER_ENVELOPE_FORMAT_VERSION = 1
const AI_CIPHER_KEY_BYTES = 32
const AI_CIPHER_IV_BYTES = 12

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const normalized = padded + "=".repeat((4 - (padded.length % 4)) % 4)
  const binary = atob(normalized)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function tryFromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return fromBase64Url(value)
  } catch {
    return null
  }
}

export interface AiCredentialKeyring {
  currentKey: CryptoKey
  currentVersion: number
  keys: ReadonlyMap<number, CryptoKey>
}

async function importAiCipherKey(
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "decrypt",
    "encrypt",
  ])
}

/**
 * Parses and validates the raw `AI_CREDENTIAL_KEYS` value. Every entry must
 * carry a unique non-negative version and exactly one 256-bit key; an empty,
 * malformed, or weak keyring is rejected loudly because silently proceeding
 * would persist ciphertexts that can never be read back. The current key is
 * the highest version, and older versions stay readable for rotation.
 */
export async function parseAiCredentialKeyring(
  rawSecret: string,
): Promise<AiCredentialKeyring> {
  if (typeof rawSecret !== "string" || rawSecret.trim() === "") {
    throw new AiCredentialCipherError(
      "invalid-keyring",
      "The AI credential keyring is empty.",
    )
  }
  const keys = new Map<number, CryptoKey>()
  let currentVersion = -1
  let currentKey: CryptoKey | undefined
  for (const rawEntry of rawSecret.split(",")) {
    const entry = rawEntry.trim()
    if (entry === "") continue
    const separator = entry.indexOf(":")
    const version = Number(
      separator > 0 ? entry.slice(0, separator) : Number.NaN,
    )
    if (!Number.isSafeInteger(version) || version < 0 || keys.has(version)) {
      throw new AiCredentialCipherError(
        "invalid-keyring",
        "The AI credential keyring entries must use unique <version>:<key> pairs.",
      )
    }
    const keyBytes = tryFromBase64Url(entry.slice(separator + 1))
    if (keyBytes === null || keyBytes.byteLength !== AI_CIPHER_KEY_BYTES) {
      throw new AiCredentialCipherError(
        "invalid-keyring",
        "The AI credential keyring keys must be 256-bit base64url values.",
      )
    }
    const key = await importAiCipherKey(keyBytes)
    keys.set(version, key)
    if (version > currentVersion) {
      currentVersion = version
      currentKey = key
    }
  }
  if (keys.size === 0 || currentKey === undefined) {
    throw new AiCredentialCipherError(
      "invalid-keyring",
      "The AI credential keyring carries no keys.",
    )
  }
  return { currentKey, currentVersion, keys }
}

interface AiCipherEnvelope {
  ct: string
  iv: string
  k: number
  v: number
}

function additionalDataBytes(
  aad: AiCipherAdditionalData,
): Uint8Array<ArrayBuffer> {
  // Copy into an explicitly allocated ArrayBuffer: the two tsconfig programs
  // disagree about TextEncoder's generic, and WebCrypto needs BufferSource.
  const encoded = new TextEncoder().encode(
    [
      "eruoo:ai-credential:v1",
      aad.environment,
      aad.connectionId,
      aad.providerType,
      aad.purpose,
    ].join("\0"),
  )
  const bytes = new Uint8Array(encoded.byteLength)
  bytes.set(encoded)
  return bytes
}

/** Encrypts one plaintext under the keyring's current key with a fresh 96-bit IV. */
export async function encryptAiSecret(
  keyring: AiCredentialKeyring,
  plaintext: string,
  aad: AiCipherAdditionalData,
): Promise<string> {
  const iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(
    new Uint8Array(AI_CIPHER_IV_BYTES),
  )
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: additionalDataBytes(aad),
      iv,
      name: "AES-GCM",
      tagLength: 128,
    },
    keyring.currentKey,
    new TextEncoder().encode(plaintext),
  )
  const envelope: AiCipherEnvelope = {
    ct: toBase64Url(new Uint8Array(ciphertext)),
    iv: toBase64Url(iv),
    k: keyring.currentVersion,
    v: AI_CIPHER_ENVELOPE_FORMAT_VERSION,
  }
  const serialized = JSON.stringify(envelope)
  if (serialized.length > AI_CREDENTIAL_CIPHERTEXT_MAX_LENGTH) {
    throw new AiCredentialCipherError(
      "malformed-envelope",
      "The encrypted AI secret exceeds its storage limit.",
    )
  }
  return serialized
}

/**
 * Decrypts an envelope. Failures are explicit: a missing key version means
 * the keyring no longer carries the recording key, and an authentication
 * failure means the ciphertext, its context binding, or the key was altered
 * (or the ciphertext belongs to a different environment/connection/purpose).
 */
export async function decryptAiSecret(
  keyring: AiCredentialKeyring,
  envelope: string,
  aad: AiCipherAdditionalData,
): Promise<string> {
  let parsed: AiCipherEnvelope
  try {
    parsed = JSON.parse(envelope) as AiCipherEnvelope
  } catch {
    throw new AiCredentialCipherError(
      "malformed-envelope",
      "The AI secret envelope is not valid JSON.",
    )
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.v !== AI_CIPHER_ENVELOPE_FORMAT_VERSION ||
    !Number.isSafeInteger(parsed.k) ||
    parsed.k < 0 ||
    typeof parsed.iv !== "string" ||
    parsed.iv === "" ||
    typeof parsed.ct !== "string" ||
    parsed.ct === ""
  ) {
    throw new AiCredentialCipherError(
      "malformed-envelope",
      "The AI secret envelope is invalid.",
    )
  }
  const key = keyring.keys.get(parsed.k)
  if (key === undefined) {
    throw new AiCredentialCipherError(
      "key-not-found",
      "The AI credential keyring does not carry the envelope's key version.",
    )
  }
  const iv = tryFromBase64Url(parsed.iv)
  if (iv === null || iv.byteLength !== AI_CIPHER_IV_BYTES) {
    throw new AiCredentialCipherError(
      "malformed-envelope",
      "The AI secret envelope IV is invalid.",
    )
  }
  const ciphertext = tryFromBase64Url(parsed.ct)
  if (ciphertext === null) {
    throw new AiCredentialCipherError(
      "malformed-envelope",
      "The AI secret envelope ciphertext is invalid.",
    )
  }
  let plaintext: ArrayBuffer
  try {
    plaintext = await crypto.subtle.decrypt(
      { additionalData: additionalDataBytes(aad), iv, name: "AES-GCM" },
      key,
      ciphertext,
    )
  } catch {
    throw new AiCredentialCipherError(
      "authentication-failed",
      "The AI secret failed authenticated decryption.",
    )
  }
  return new TextDecoder().decode(plaintext)
}

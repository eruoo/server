import { drizzle } from "drizzle-orm/d1"
import type { Context } from "hono"

import { securityAuditEvents } from "./db/schema"
import type { AppBindings } from "./http/types"

export const auditEventTypes = [
  "ai_authorization_cancelled",
  "ai_authorization_completed",
  "ai_authorization_started",
  "api_key_created",
  "api_key_expired",
  "api_key_rejected",
  "api_key_revoked",
  "api_key_updated",
  "database_restore_completed",
  "github_login",
  "jwt_signing_key_rotated",
  "oauth_grant_created",
  "oauth_grant_revoked",
  "oauth_refresh_reuse_detected",
  "passkey_created",
  "passkey_deleted",
  "passkey_login",
  "passkey_updated",
  "security_configuration_changed",
  "sensitive_operation_denied",
] as const

export type AuditOutcome = "failure" | "success"
export type AuditEventType = (typeof auditEventTypes)[number]

const auditIpFingerprintDomain = "eruoo:audit-ip:v1"

export class InvalidAuditSecretError extends Error {
  override readonly name = "InvalidAuditSecretError"
}

export interface AuditEvent {
  clientId?: string
  credentialId?: string
  metadata?: Readonly<Record<string, boolean | number | string>>
  outcome: AuditOutcome
  subjectId?: string
  type: AuditEventType
}

export function assertAuditSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    new TextEncoder().encode(secret).byteLength < 32
  ) {
    throw new InvalidAuditSecretError(
      "The audit HMAC secret must contain at least 32 UTF-8 bytes.",
    )
  }
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

async function fingerprintIp(
  ipAddress: string | null,
  secret: string,
): Promise<string | null> {
  if (!ipAddress) {
    return null
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${auditIpFingerprintDomain}\0${ipAddress}`),
  )
  return toHex(signature)
}

const metadataFields: Record<AuditEventType, readonly string[]> = {
  ai_authorization_cancelled: ["connectionId", "providerType"],
  ai_authorization_completed: ["connectionId", "providerType"],
  ai_authorization_started: ["connectionId", "providerType"],
  api_key_created: ["status"],
  api_key_updated: ["status"],
  api_key_revoked: ["status"],
  api_key_expired: ["reason"],
  api_key_rejected: ["reason"],
  github_login: ["status"],
  passkey_login: ["status"],
  passkey_created: ["status"],
  passkey_updated: ["status"],
  passkey_deleted: ["status"],
  oauth_grant_created: ["status"],
  oauth_grant_revoked: [
    "tokenType",
    "deletedConsentCount",
    "revokedRefreshTokenCount",
  ],
  oauth_refresh_reuse_detected: ["reason"],
  sensitive_operation_denied: ["status"],
  jwt_signing_key_rotated: ["algorithm"],
  security_configuration_changed: ["setting"],
  database_restore_completed: ["source", "target"],
}
function auditMetadata(event: AuditEvent): string | null {
  const allowed = metadataFields[event.type]
  const entries = Object.entries(event.metadata ?? {}).filter(
    ([key, value]) =>
      allowed.includes(key) &&
      (typeof value !== "string" || value.length <= 256) &&
      (typeof value !== "number" || Number.isFinite(value)),
  )
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null
}

export async function recordAuditEvent(
  env: Pick<Env, "AUDIT_IP_HASH_SECRET" | "DB">,
  ipAddress: string | null,
  requestId: string,
  event: AuditEvent,
): Promise<void> {
  assertAuditSecret(env.AUDIT_IP_HASH_SECRET)
  const ipFingerprint = await fingerprintIp(ipAddress, env.AUDIT_IP_HASH_SECRET)
  const database = drizzle(env.DB)

  await database.insert(securityAuditEvents).values({
    clientId: event.clientId,
    credentialId: event.credentialId,
    id: crypto.randomUUID(),
    ipFingerprint,
    metadata: auditMetadata(event),
    occurredAt: Date.now(),
    outcome: event.outcome,
    requestId,
    subjectId: event.subjectId,
    type: event.type,
  })
}

export function scheduleAuditEvent(
  context: Context<AppBindings>,
  event: AuditEvent,
): void {
  context.executionCtx.waitUntil(
    recordAuditEvent(
      context.env,
      context.req.header("cf-connecting-ip") ?? null,
      context.get("requestId"),
      event,
    ).catch((error: unknown) => {
      console.warn({
        event: "audit_write_failed",
        error: error instanceof Error ? error.name : "unknown_error",
        requestId: context.get("requestId"),
      })
    }),
  )
}

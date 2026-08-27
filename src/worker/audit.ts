import { drizzle } from "drizzle-orm/d1"
import type { Context } from "hono"

import type { WorkerAuthEnv } from "./auth"
import { securityAuditEvents } from "./db/schema"
import type { AppBindings } from "./http/types"

export const auditEventTypes = [
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
  if (new TextEncoder().encode(secret).byteLength < 32) {
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

export async function recordAuditEvent(
  env: Pick<WorkerAuthEnv, "AUDIT_IP_HASH_SECRET" | "DB">,
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
    metadata: event.metadata ? JSON.stringify(event.metadata) : null,
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

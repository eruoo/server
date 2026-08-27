import type { Context } from "hono"
import { decodeProtectedHeader } from "jose"

import type { AuditEvent } from "../audit"
import { recordAuditEvent } from "../audit"
import type { AppBindings } from "../http/types"
import { parseOAuthFormRequest } from "./oauth-protocol"

interface RefreshTokenRow {
  clientId: string
  expiresAt: string | number
  id: string
  revoked: string | number | null
  rotatedAt: string | number | null
  rotationReplayExpiresAt: string | number | null
  userId: string
}

type OAuthProtocolAuditCapture =
  | {
      clientId?: string
      kind: "authorization"
    }
  | {
      clientId?: string
      kind: "refresh"
      observedAt: number
      refreshToken?: RefreshTokenRow
    }
  | {
      clientId?: string
      kind: "token"
    }
  | {
      clientId?: string
      kind: "revocation"
      refreshToken?: RefreshTokenRow
    }

function toBase64Url(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

async function hashStoredOAuthToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  )
  return toBase64Url(new Uint8Array(digest))
}

function exactlyOneString(
  values: URLSearchParams,
  name: string,
): string | undefined {
  const entries = values.getAll(name)
  return entries.length === 1 ? entries[0] : undefined
}

async function findRefreshToken(
  database: D1Database,
  rawToken: string | undefined,
): Promise<RefreshTokenRow | undefined> {
  if (!rawToken) return undefined

  return (
    (await database
      .prepare(
        `SELECT id, clientId, userId, expiresAt, revoked, rotatedAt,
                rotationReplayExpiresAt
         FROM oauthRefreshToken
         WHERE token = ?1
         LIMIT 1`,
      )
      .bind(await hashStoredOAuthToken(rawToken))
      .first<RefreshTokenRow>()) ?? undefined
  )
}

export async function captureOAuthProtocolAudit(
  context: Context<AppBindings>,
): Promise<OAuthProtocolAuditCapture | undefined> {
  const path = context.req.path

  if (path === "/api/auth/oauth2/authorize") {
    const values =
      context.req.method === "GET"
        ? new URL(context.req.url).searchParams
        : await parseOAuthFormRequest(context.req.raw)

    if (!values) return { kind: "authorization" }
    const clientId = exactlyOneString(values, "client_id")
    return {
      ...(clientId === undefined ? {} : { clientId }),
      kind: "authorization",
    }
  }

  if (path !== "/api/auth/oauth2/token" && path !== "/api/auth/oauth2/revoke") {
    return undefined
  }

  const values = await parseOAuthFormRequest(context.req.raw)
  const clientId = values ? exactlyOneString(values, "client_id") : undefined

  if (path === "/api/auth/oauth2/token") {
    if (values?.get("grant_type") !== "refresh_token") {
      return {
        ...(clientId === undefined ? {} : { clientId }),
        kind: "token",
      }
    }

    try {
      const refreshToken = await findRefreshToken(
        context.env.DB,
        exactlyOneString(values, "refresh_token"),
      )
      return {
        ...(clientId === undefined ? {} : { clientId }),
        kind: "refresh",
        observedAt: Date.now(),
        ...(refreshToken === undefined ? {} : { refreshToken }),
      }
    } catch (error) {
      console.warn({
        error: error instanceof Error ? error.name : "unknown_error",
        event: "oauth_audit_detection_failed",
        requestId: context.get("requestId"),
      })
      return {
        ...(clientId === undefined ? {} : { clientId }),
        kind: "refresh",
        observedAt: Date.now(),
      }
    }
  }

  if (context.get("oauthRefreshFamilyRevocationManaged") === true) {
    return undefined
  }

  try {
    const refreshToken = await findRefreshToken(
      context.env.DB,
      values ? exactlyOneString(values, "token") : undefined,
    )
    return {
      ...(clientId === undefined ? {} : { clientId }),
      kind: "revocation",
      ...(refreshToken === undefined ? {} : { refreshToken }),
    }
  } catch (error) {
    console.warn({
      error: error instanceof Error ? error.name : "unknown_error",
      event: "oauth_audit_detection_failed",
      requestId: context.get("requestId"),
    })
    return {
      ...(clientId === undefined ? {} : { clientId }),
      kind: "revocation",
    }
  }
}

function dateMilliseconds(value: string | number | null): number | undefined {
  if (value === null) return undefined
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

async function hasAuthorizationCode(response: Response): Promise<boolean> {
  const location = response.headers.get("location")
  if (location && response.status >= 300 && response.status < 400) {
    try {
      const target = new URL(location)
      return (
        target.searchParams.has("code") && !target.searchParams.has("error")
      )
    } catch {
      return false
    }
  }

  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return false
  }

  try {
    const body: unknown = await response.clone().json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("url" in body) ||
      typeof body.url !== "string"
    ) {
      return false
    }

    const target = new URL(body.url)
    return target.searchParams.has("code") && !target.searchParams.has("error")
  } catch {
    return false
  }
}

async function responseOAuthError(
  response: Response,
): Promise<string | undefined> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return undefined
  }

  try {
    const body: unknown = await response.clone().json()
    return typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
      ? body.error
      : undefined
  } catch {
    return undefined
  }
}

async function recordJwtSigningKeyRotationAudit(
  context: Context<AppBindings>,
  capture: OAuthProtocolAuditCapture,
  response: Response,
): Promise<void> {
  if (
    (capture.kind !== "refresh" && capture.kind !== "token") ||
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return
  }

  let accessToken: string
  try {
    const body: unknown = await response.clone().json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("access_token" in body) ||
      typeof body.access_token !== "string"
    ) {
      return
    }
    accessToken = body.access_token
  } catch {
    return
  }

  let algorithm: "EdDSA" | "RS256"
  let keyId: string
  try {
    const header = decodeProtectedHeader(accessToken)
    if (
      (header.alg !== "EdDSA" && header.alg !== "RS256") ||
      typeof header.kid !== "string" ||
      header.kid.length === 0 ||
      header.kid.length > 128 ||
      header.kid.trim() !== header.kid
    ) {
      return
    }
    algorithm = header.alg
    keyId = header.kid
  } catch {
    return
  }

  await context.env.DB.prepare(
    `INSERT INTO security_audit_events (
       id, type, outcome, occurredAt, subjectId, credentialId, clientId,
       ipFingerprint, requestId, metadata
     )
     SELECT ?1, 'jwt_signing_key_rotated', 'success', ?2, NULL, ?3, ?4,
            NULL, ?5, ?6
     FROM jwks AS current_key
     WHERE current_key.id = ?3
       AND COALESCE(current_key.alg, 'EdDSA') = ?7
       AND EXISTS (
         SELECT 1
         FROM jwks AS previous_key
         WHERE previous_key.id <> current_key.id
           AND COALESCE(previous_key.alg, 'EdDSA') = ?7
           AND (
             previous_key.createdAt < current_key.createdAt
             OR (
               previous_key.createdAt = current_key.createdAt
               AND previous_key.rowid < current_key.rowid
             )
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM security_audit_events AS existing_audit
         WHERE existing_audit.type = 'jwt_signing_key_rotated'
           AND existing_audit.credentialId = ?3
       )`,
  )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      keyId,
      capture.clientId ?? null,
      context.get("requestId"),
      JSON.stringify({ algorithm }),
      algorithm,
    )
    .run()
}

async function resolveOAuthProtocolAuditEvent(
  context: Context<AppBindings>,
  capture: OAuthProtocolAuditCapture,
  response: Response,
  responseObservedAt: number,
): Promise<AuditEvent | undefined> {
  if (capture.kind === "authorization") {
    if (!capture.clientId || !(await hasAuthorizationCode(response))) {
      return undefined
    }

    return {
      clientId: capture.clientId,
      metadata: { flow: "authorization_code" },
      outcome: "success",
      type: "oauth_grant_created",
    }
  }

  if (capture.kind === "token") return undefined

  const refreshToken = capture.refreshToken
  if (!refreshToken || refreshToken.clientId !== capture.clientId) {
    return undefined
  }

  if (capture.kind === "refresh") {
    const refreshExpiresAt = dateMilliseconds(refreshToken.expiresAt)
    const replayExpiredAt = dateMilliseconds(
      refreshToken.rotationReplayExpiresAt,
    )
    const observedAt = Math.max(capture.observedAt, responseObservedAt)
    if (
      refreshToken.rotatedAt === null ||
      refreshExpiresAt === undefined ||
      refreshExpiresAt <= observedAt ||
      replayExpiredAt === undefined ||
      replayExpiredAt >= observedAt ||
      (await responseOAuthError(response)) !== "invalid_grant"
    ) {
      return undefined
    }

    return {
      clientId: refreshToken.clientId,
      metadata: { reason: "outside_retry_window" },
      outcome: "failure",
      subjectId: refreshToken.userId,
      type: "oauth_refresh_reuse_detected",
    }
  }

  if (refreshToken.revoked !== null || !response.ok) return undefined

  const stored = await context.env.DB.prepare(
    `SELECT revoked
     FROM oauthRefreshToken
     WHERE id = ?1
     LIMIT 1`,
  )
    .bind(refreshToken.id)
    .first<{ revoked: string | number | null }>()

  if (!stored || stored.revoked === null) return undefined

  return {
    clientId: refreshToken.clientId,
    metadata: { tokenType: "refresh_token" },
    outcome: "success",
    subjectId: refreshToken.userId,
    type: "oauth_grant_revoked",
  }
}

export function scheduleOAuthProtocolAudit(
  context: Context<AppBindings>,
  capture: OAuthProtocolAuditCapture | undefined,
  response: Response,
): void {
  if (!capture || response.status === 429) return

  const requestId = context.get("requestId")
  const responseObservedAt = Date.now()
  context.executionCtx.waitUntil(
    (async () => {
      try {
        await recordJwtSigningKeyRotationAudit(context, capture, response)
      } catch (error) {
        console.warn({
          error: error instanceof Error ? error.name : "unknown_error",
          event: "audit_write_failed",
          requestId,
        })
      }

      try {
        const event = await resolveOAuthProtocolAuditEvent(
          context,
          capture,
          response,
          responseObservedAt,
        )
        if (!event) return
        await recordAuditEvent(
          context.env,
          context.req.header("cf-connecting-ip") ?? null,
          requestId,
          event,
        )
      } catch (error) {
        console.warn({
          error: error instanceof Error ? error.name : "unknown_error",
          event: "audit_write_failed",
          requestId,
        })
      }
    })(),
  )
}

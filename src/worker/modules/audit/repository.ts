import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { z } from "zod"

import {
  assertAuditSecret,
  auditEventTypes,
  type AuditEventType,
  type AuditOutcome,
} from "../../audit"
import { securityAuditEvents } from "../../db/schema"

const auditRetentionMs = 180 * 24 * 60 * 60 * 1000
const defaultPageSize = 50
const maximumPageSize = 100
const cursorDomain = "eruoo:audit-cursor:v1"
const textEncoder = new TextEncoder()

const cursorPayloadSchema = z.object({
  filters: z.object({
    from: z.number().int().nullable(),
    outcome: z.enum(["failure", "success"]).nullable(),
    to: z.number().int().nullable(),
    type: z.enum(auditEventTypes).nullable(),
  }),
  id: z.string().min(1),
  occurredAt: z.number().int(),
  version: z.literal(1),
})

const metadataSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.number(), z.string()]),
)
const storedAuditRowSchema = z.object({
  clientId: z.string().min(1).nullable(),
  credentialId: z.string().min(1).nullable(),
  id: z.string().min(1),
  ipFingerprint: z.string().min(1).nullable(),
  metadata: z.string().nullable(),
  occurredAt: z.number().int().nonnegative(),
  outcome: z.enum(["failure", "success"]),
  requestId: z.string().min(1),
  subjectId: z.string().min(1).nullable(),
  type: z.enum(auditEventTypes),
})

export interface AuditEventFilters {
  from?: number
  outcome?: AuditOutcome
  to?: number
  type?: AuditEventType
}

export interface AuditEventListOptions extends AuditEventFilters {
  cursor?: string
  limit?: number
  now?: number
}

export interface StoredAuditEvent {
  clientId: string | null
  credentialId: string | null
  id: string
  ipFingerprint: string | null
  metadata: Record<string, boolean | number | string> | null
  occurredAt: number
  outcome: AuditOutcome
  requestId: string
  subjectId: string | null
  type: AuditEventType
}

export interface AuditEventPage {
  events: StoredAuditEvent[]
  nextCursor: string | null
}

export class InvalidAuditCursorError extends Error {
  override readonly name = "InvalidAuditCursorError"
}

export class InvalidStoredAuditEventError extends Error {
  override readonly name = "InvalidStoredAuditEventError"
}

function normalizedFilters(filters: AuditEventFilters) {
  return {
    from: filters.from ?? null,
    outcome: filters.outcome ?? null,
    to: filters.to ?? null,
    type: filters.type ?? null,
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidAuditCursorError("The audit cursor is malformed.")
  }

  const standard = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")

  try {
    const decoded = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    )

    if (toBase64Url(decoded) !== value) {
      throw new InvalidAuditCursorError("The audit cursor is malformed.")
    }

    return decoded
  } catch {
    throw new InvalidAuditCursorError("The audit cursor is malformed.")
  }
}

async function importCursorKey(secret: string): Promise<CryptoKey> {
  assertAuditSecret(secret)
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  )
}

async function signCursorPayload(
  payload: string,
  secret: string,
): Promise<Uint8Array> {
  const key = await importCursorKey(secret)
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${cursorDomain}\0${payload}`),
    ),
  )
}

async function encodeCursor(
  cursor: { id: string; occurredAt: number },
  filters: AuditEventFilters,
  secret: string,
): Promise<string> {
  const payload = JSON.stringify({
    filters: normalizedFilters(filters),
    id: cursor.id,
    occurredAt: cursor.occurredAt,
    version: 1,
  })
  const payloadBytes = textEncoder.encode(payload)
  const signature = await signCursorPayload(payload, secret)

  return `${toBase64Url(payloadBytes)}.${toBase64Url(signature)}`
}

async function decodeCursor(
  cursor: string,
  filters: AuditEventFilters,
  secret: string,
): Promise<z.infer<typeof cursorPayloadSchema>> {
  const parts = cursor.split(".")

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidAuditCursorError("The audit cursor is malformed.")
  }

  const payloadBytes = fromBase64Url(parts[0])
  const signature = fromBase64Url(parts[1])
  const payload = new TextDecoder().decode(payloadBytes)
  const key = await importCursorKey(secret)
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    textEncoder.encode(`${cursorDomain}\0${payload}`),
  )

  if (!validSignature) {
    throw new InvalidAuditCursorError("The audit cursor is invalid.")
  }

  let decoded: unknown

  try {
    decoded = JSON.parse(payload)
  } catch {
    throw new InvalidAuditCursorError("The audit cursor is malformed.")
  }

  const parsed = cursorPayloadSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new InvalidAuditCursorError("The audit cursor is malformed.")
  }

  if (
    JSON.stringify(parsed.data.filters) !==
    JSON.stringify(normalizedFilters(filters))
  ) {
    throw new InvalidAuditCursorError(
      "The audit cursor does not match the active filters.",
    )
  }

  return parsed.data
}

function parseMetadata(
  value: string | null,
): Record<string, boolean | number | string> | null {
  if (!value) return null

  let decoded: unknown

  try {
    decoded = JSON.parse(value)
  } catch {
    throw new InvalidStoredAuditEventError(
      "Stored audit metadata is not valid JSON.",
    )
  }

  const parsed = metadataSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new InvalidStoredAuditEventError(
      "Stored audit metadata does not match the expected schema.",
    )
  }

  return parsed.data
}

function parseStoredAuditEvent(row: unknown): StoredAuditEvent {
  const parsed = storedAuditRowSchema.safeParse(row)

  if (!parsed.success) {
    throw new InvalidStoredAuditEventError(
      "Stored audit data does not match the expected schema.",
    )
  }

  return {
    ...parsed.data,
    metadata: parseMetadata(parsed.data.metadata),
  }
}

export async function listAuditEvents(
  databaseBinding: D1Database,
  secret: string,
  options: AuditEventListOptions = {},
): Promise<AuditEventPage> {
  assertAuditSecret(secret)
  const now = options.now ?? Date.now()
  const limit = options.limit ?? defaultPageSize

  if (!Number.isInteger(limit) || limit < 1 || limit > maximumPageSize) {
    throw new RangeError(`Audit page size must be between 1 and 100.`)
  }

  if (
    (options.from !== undefined && !Number.isInteger(options.from)) ||
    (options.to !== undefined && !Number.isInteger(options.to)) ||
    (options.from !== undefined &&
      options.to !== undefined &&
      options.from > options.to)
  ) {
    throw new RangeError("Audit time filters are invalid.")
  }

  const filters: AuditEventFilters = {
    ...(options.from === undefined ? {} : { from: options.from }),
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.to === undefined ? {} : { to: options.to }),
    ...(options.type === undefined ? {} : { type: options.type }),
  }
  const cursor = options.cursor
    ? await decodeCursor(options.cursor, filters, secret)
    : undefined
  const conditions = [
    gte(securityAuditEvents.occurredAt, now - auditRetentionMs),
  ]

  if (filters.from !== undefined) {
    conditions.push(gte(securityAuditEvents.occurredAt, filters.from))
  }
  if (filters.to !== undefined) {
    conditions.push(lte(securityAuditEvents.occurredAt, filters.to))
  }
  if (filters.outcome !== undefined) {
    conditions.push(eq(securityAuditEvents.outcome, filters.outcome))
  }
  if (filters.type !== undefined) {
    conditions.push(eq(securityAuditEvents.type, filters.type))
  }
  if (cursor) {
    conditions.push(
      or(
        lt(securityAuditEvents.occurredAt, cursor.occurredAt),
        and(
          eq(securityAuditEvents.occurredAt, cursor.occurredAt),
          lt(securityAuditEvents.id, cursor.id),
        ),
      )!,
    )
  }

  const database = drizzle(databaseBinding)
  const rows = await database
    .select()
    .from(securityAuditEvents)
    .where(and(...conditions))
    .orderBy(desc(securityAuditEvents.occurredAt), desc(securityAuditEvents.id))
    .limit(limit + 1)
  const hasNextPage = rows.length > limit
  const visibleRows = hasNextPage ? rows.slice(0, limit) : rows
  const lastVisibleRow = visibleRows.at(-1)
  const events = visibleRows.map(parseStoredAuditEvent)

  return {
    events,
    nextCursor:
      hasNextPage && lastVisibleRow
        ? await encodeCursor(lastVisibleRow, filters, secret)
        : null,
  }
}

export async function deleteExpiredAuditEvents(
  databaseBinding: D1Database,
  now = Date.now(),
): Promise<number> {
  const database = drizzle(databaseBinding)
  const result = await database
    .delete(securityAuditEvents)
    .where(lt(securityAuditEvents.occurredAt, now - auditRetentionMs))

  return result.meta.changes
}

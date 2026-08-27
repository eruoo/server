/// <reference types="vite/client" />

import { betterAuth } from "better-auth"
import { testUtils, type TestHelpers } from "better-auth/plugins"

import { OAUTH_RESOURCE } from "../../src/shared/oauth"
import { createAuth, createAuthOptions } from "../../src/worker/auth"
import productionWorker from "../../src/worker/index"
import {
  e2eBootstrapPath,
  e2eBootstrapToken,
  e2eCurrentSessionPath,
  e2eStaleSessionPath,
} from "../client/e2e/support"
import { splitD1MigrationStatements } from "./e2e-migrations"

export { DatabaseBackupWorkflow } from "../../src/worker/index"

interface E2EEnv extends Env {
  E2E_BOOTSTRAP_TOKEN: string
}

const ownerUserId = "synthetic-e2e-owner"
const ownerAccountId = "synthetic-e2e-owner-github-account"
const desktopClientId = "eruoo-desktop"
const seededAuditEventId = "synthetic-e2e-github-login"
const staleReauthenticationOffsetMs = 16 * 60 * 1000
const migrationModules = import.meta.glob<string>("../../migrations/*.sql", {
  eager: true,
  import: "default",
  query: "?raw",
})

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

async function migrationDigest(migrationSql: string): Promise<string> {
  return toHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(migrationSql),
    ),
  )
}

async function ensureFoundationSchema(database: D1Database): Promise<void> {
  await database
    .prepare(
      `CREATE TABLE IF NOT EXISTS "__e2e_migrations" (
         "name" TEXT NOT NULL PRIMARY KEY,
         "digest" TEXT NOT NULL
       )`,
    )
    .run()

  for (const [modulePath, migrationSql] of Object.entries(
    migrationModules,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const migrationName = modulePath.split("/").at(-1)
    if (!migrationName) {
      throw new Error("An E2E migration module has no file name.")
    }

    const digest = await migrationDigest(migrationSql)
    const applied = await database
      .prepare(
        `SELECT digest
         FROM "__e2e_migrations"
         WHERE name = ?1`,
      )
      .bind(migrationName)
      .first<{ digest: string }>()

    if (applied) {
      if (applied.digest !== digest) {
        throw new Error(
          `Applied E2E migration ${migrationName} no longer matches its source.`,
        )
      }
      continue
    }

    const statements = splitD1MigrationStatements(migrationSql)
    if (statements.length === 0) {
      throw new Error(`E2E migration ${migrationName} contains no SQL.`)
    }

    await database.batch([
      ...statements.map((statement) => database.prepare(statement)),
      database
        .prepare(
          `INSERT INTO "__e2e_migrations" (name, digest)
           VALUES (?1, ?2)`,
        )
        .bind(migrationName, digest),
    ])
  }
}

async function resetAuthenticationState(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DELETE FROM oauthAccessToken"),
    database.prepare("DELETE FROM oauthRefreshToken"),
    database.prepare("DELETE FROM oauthRefreshTokenFamilyRevocation"),
    database.prepare("DELETE FROM oauthConsent"),
    database.prepare("DELETE FROM passkey"),
    database.prepare("DELETE FROM apikey"),
    database.prepare("DELETE FROM session"),
    database.prepare("DELETE FROM account"),
    database.prepare("DELETE FROM verification"),
    database.prepare("DELETE FROM rateLimit"),
    database.prepare("DELETE FROM security_audit_events"),
    database.prepare("DELETE FROM maintenance_lease"),
    database.prepare("DELETE FROM database_backup_health"),
    database.prepare("DELETE FROM user"),
  ])
}

interface SeededSecurityFixtures {
  auditEvent: {
    id: string
    occurredAt: number
  }
  oauthClientId: typeof desktopClientId
}

async function seedSecurityFixtures(
  database: D1Database,
  now: Date,
): Promise<SeededSecurityFixtures> {
  const occurredAt = Math.floor((now.getTime() - 2 * 60 * 1000) / 1000) * 1000
  const authorizedAt = new Date(occurredAt - 60 * 1000).toISOString()
  const refreshExpiresAt = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString()
  const resources = JSON.stringify([OAUTH_RESOURCE])
  const scopes = JSON.stringify([
    "openid",
    "profile",
    "api:read",
    "offline_access",
  ])

  await database.batch([
    database
      .prepare(
        `INSERT INTO oauthConsent (
           id, clientId, userId, resources, scopes, createdAt, updatedAt
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        "synthetic-e2e-desktop-consent",
        desktopClientId,
        ownerUserId,
        resources,
        scopes,
        authorizedAt,
        authorizedAt,
      ),
    database
      .prepare(
        `INSERT INTO oauthRefreshToken (
           id, token, clientId, userId, resources, expiresAt, createdAt,
           scopes
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        "synthetic-e2e-desktop-refresh",
        "synthetic-refresh-digest-not-a-credential",
        desktopClientId,
        ownerUserId,
        resources,
        refreshExpiresAt,
        authorizedAt,
        scopes,
      ),
    database
      .prepare(
        `INSERT INTO security_audit_events (
           id, type, outcome, occurredAt, subjectId, credentialId,
           clientId, ipFingerprint, requestId, metadata
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        seededAuditEventId,
        "github_login",
        "success",
        occurredAt,
        ownerUserId,
        ownerAccountId,
        null,
        null,
        "synthetic-e2e-audit-request",
        JSON.stringify({ fixture: true, method: "github" }),
      ),
  ])

  return {
    auditEvent: { id: seededAuditEventId, occurredAt },
    oauthClientId: desktopClientId,
  }
}

async function bootstrapOwner(env: E2EEnv): Promise<Response> {
  await ensureFoundationSchema(env.DB)
  await resetAuthenticationState(env.DB)

  const now = new Date()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (
         id, name, email, emailVerified, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      ownerUserId,
      "Synthetic E2E Owner",
      "owner@example.invalid",
      1,
      now.toISOString(),
      now.toISOString(),
    ),
    env.DB.prepare(
      `INSERT INTO account (
         id, issuer, accountId, providerId, userId, createdAt, updatedAt
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      ownerAccountId,
      "https://github.com",
      "50254496",
      "github",
      ownerUserId,
      now.toISOString(),
      now.toISOString(),
    ),
  ])
  const fixtures = await seedSecurityFixtures(env.DB, now)

  const authOptions = createAuthOptions(env, env.DB)
  const testAuth = betterAuth({
    ...authOptions,
    plugins: [
      ...(authOptions.plugins ?? []),
      testUtils() as unknown as NonNullable<
        (typeof authOptions)["plugins"]
      >[number],
    ],
  })
  const testContext = (await testAuth.$context) as Awaited<
    typeof testAuth.$context
  > & { test: TestHelpers }
  const { cookies } = await testContext.test.login({ userId: ownerUserId })
  const sessionCookie = cookies[0]

  if (!sessionCookie) {
    throw new Error("Better Auth did not create an E2E Session cookie.")
  }

  return Response.json(
    {
      cookie: sessionCookie,
      fixtures,
      user: { id: ownerUserId, name: "Synthetic E2E Owner" },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  )
}

interface PersistedOwnerSession {
  id: string
  reauthenticatedAt: string
}

async function getPersistedOwnerSession(
  request: Request,
  env: E2EEnv,
): Promise<PersistedOwnerSession | null> {
  const result = await createAuth(env).api.getSession({
    headers: request.headers,
  })

  if (!result || result.user.id !== ownerUserId) {
    return null
  }

  return env.DB.prepare(
    `SELECT id, reauthenticatedAt
     FROM session
     WHERE id = ?1 AND userId = ?2
     LIMIT 1`,
  )
    .bind(result.session.id, ownerUserId)
    .first<PersistedOwnerSession>()
}

function sessionStateResponse(session: PersistedOwnerSession): Response {
  return Response.json(session, {
    headers: { "Cache-Control": "no-store" },
  })
}

async function readCurrentSession(
  request: Request,
  env: E2EEnv,
): Promise<Response> {
  const session = await getPersistedOwnerSession(request, env)
  return session
    ? sessionStateResponse(session)
    : new Response(null, { status: 404 })
}

async function staleCurrentSession(
  request: Request,
  env: E2EEnv,
): Promise<Response> {
  const session = await getPersistedOwnerSession(request, env)
  if (!session) {
    return new Response(null, { status: 404 })
  }

  const reauthenticatedAt = new Date(
    Date.now() - staleReauthenticationOffsetMs,
  ).toISOString()
  await env.DB.prepare(
    `UPDATE session
     SET reauthenticatedAt = ?1
     WHERE id = ?2 AND userId = ?3`,
  )
    .bind(reauthenticatedAt, session.id, ownerUserId)
    .run()

  return readCurrentSession(request, env)
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    const isAuthorizedFixture =
      request.headers.get("x-e2e-bootstrap-token") === e2eBootstrapToken &&
      env.E2E_BOOTSTRAP_TOKEN === e2eBootstrapToken

    if (
      isAuthorizedFixture &&
      request.method === "POST" &&
      url.pathname === e2eBootstrapPath
    ) {
      return bootstrapOwner(env)
    }

    if (
      isAuthorizedFixture &&
      request.method === "POST" &&
      url.pathname === e2eStaleSessionPath
    ) {
      return staleCurrentSession(request, env)
    }

    if (
      isAuthorizedFixture &&
      request.method === "GET" &&
      url.pathname === e2eCurrentSessionPath
    ) {
      return readCurrentSession(request, env)
    }

    return productionWorker.fetch(request, env, context)
  },
} satisfies ExportedHandler<E2EEnv>

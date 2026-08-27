import { OpenAPIHono } from "@hono/zod-openapi"
import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { recordDatabaseBackupTerminalState } from "../../src/worker/backup/health"
import { requestId } from "../../src/worker/http/request-id"
import type { AppBindings } from "../../src/worker/http/types"
import { backupStatusRouter } from "../../src/worker/routes/backup-status"
import { createOwnerSession } from "./fixtures/owner-session"

const routeFixture = new OpenAPIHono<AppBindings>({ strict: true })
routeFixture.use("*", requestId)
routeFixture.route("/", backupStatusRouter)

function environmentWithDatabase(database: D1Database): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DB") return database
      return Reflect.get(target, property, receiver)
    },
  })
}

function databaseWithUnavailableBackupHealth(): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (query.includes("database_backup_health")) {
            throw new Error("synthetic sensitive D1 failure detail")
          }

          return target.prepare(query)
        }
      }

      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function statementWithInvalidBackupHealth(
  statement: D1PreparedStatement,
): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          statementWithInvalidBackupHealth(target.bind(...values))
      }

      if (property === "raw") {
        return async () => [
          [
            "database-backup",
            "failed",
            "workflow-corrupt",
            2_000_000_000_000,
            2_000_000_010_000,
            null,
            "synthetic raw database detail",
          ],
        ]
      }

      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function databaseWithInvalidBackupHealth(): D1Database {
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query)
          return query.includes("database_backup_health")
            ? statementWithInvalidBackupHealth(statement)
            : statement
        }
      }

      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

async function fetchRouteFixture(
  request: Request,
  requestEnv: Env,
): Promise<Response> {
  const executionContext = createExecutionContext()
  const response = await routeFixture.fetch(
    request,
    requestEnv,
    executionContext,
  )
  await waitOnExecutionContext(executionContext)
  return response
}

describe("GET /api/security/backup-status", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM database_backup_health"),
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("registers an owner-only OpenAPI contract with epoch-millisecond fields", () => {
    const document = backupStatusRouter.getOpenAPI31Document({
      info: { title: "Backup status contract test", version: "test" },
      openapi: "3.1.0",
    })
    const operation = document.paths?.["/api/security/backup-status"]?.get
    const schema = document.components?.schemas?.["DatabaseBackupStatus"]

    if (!schema) {
      throw new Error("The backup status OpenAPI schema is missing.")
    }

    expect(operation).toMatchObject({
      operationId: "getDatabaseBackupStatus",
      security: [{ ownerSession: [] }],
    })
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "500",
      "503",
      "504",
    ])
    expect(schema).toMatchObject({
      oneOf: [
        { properties: { status: { enum: ["never-run"] } } },
        {
          properties: {
            lastAttemptAt: {
              format: "int64",
              maximum: 8_640_000_000_000_000,
            },
            status: { enum: ["ok"] },
          },
        },
        {
          properties: {
            errorCode: { type: "string" },
            lastAttemptAt: {
              format: "int64",
              maximum: 8_640_000_000_000_000,
            },
            status: { enum: ["failed"] },
          },
        },
      ],
    })
  })

  it.each([
    { headers: undefined, name: "missing credentials" },
    { headers: { "x-api-key": "eruoo_synthetic" }, name: "an API key" },
    {
      headers: { authorization: "Bearer synthetic.token" },
      name: "an OAuth bearer token",
    },
  ])("rejects $name", async ({ headers }) => {
    const response = await SELF.fetch(
      "http://local.test/api/security/backup-status",
      headers === undefined ? undefined : { headers },
    )

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toMatchObject({
      status: 401,
      type: "https://auth.eruoo.me/problems/authentication-required",
    })
  })

  it("rejects ambiguous credential carriers", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/security/backup-status",
      {
        headers: {
          authorization: "Bearer synthetic.token",
          cookie: "eruoo.session_token=synthetic",
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
  })

  it("returns the never-run state to the owner without caching", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch(
      "http://local.test/api/security/backup-status",
      { headers: { cookie: `eruoo.session_token=${cookie}` } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    await expect(response.json()).resolves.toEqual({
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
    })
  })

  it("returns a persisted failed state without exposing raw errors", async () => {
    const cookie = await createOwnerSession()
    await recordDatabaseBackupTerminalState(env.DB, {
      completedAt: 2_000_000_010_000,
      failureCode: "backup_upload_integrity_failed",
      runId: "workflow-failed",
      startedAt: 2_000_000_000_000,
      status: "failed",
    })
    const response = await SELF.fetch(
      "http://local.test/api/security/backup-status",
      { headers: { cookie: `eruoo.session_token=${cookie}` } },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      errorCode: "backup_upload_integrity_failed",
      lastAttemptAt: 2_000_000_010_000,
      lastSuccessAt: null,
      status: "failed",
    })
  })

  it("maps a D1 read failure to a generic 503", async () => {
    const cookie = await createOwnerSession()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const response = await fetchRouteFixture(
        new Request("http://local.test/api/security/backup-status", {
          headers: { cookie: `eruoo.session_token=${cookie}` },
        }),
        environmentWithDatabase(databaseWithUnavailableBackupHealth()),
      )
      const body = await response.text()

      expect(response.status).toBe(503)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      )
      expect(body).not.toContain("synthetic sensitive D1 failure detail")
      expect(JSON.parse(body)).toMatchObject({
        status: 503,
        type: "https://auth.eruoo.me/problems/service-unavailable",
      })
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Error",
          event: "database_backup_status_query_failed",
        }),
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  it("maps invalid stored health to a generic 500", async () => {
    const cookie = await createOwnerSession()
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      const response = await fetchRouteFixture(
        new Request("http://local.test/api/security/backup-status", {
          headers: { cookie: `eruoo.session_token=${cookie}` },
        }),
        environmentWithDatabase(databaseWithInvalidBackupHealth()),
      )
      const body = await response.text()

      expect(response.status).toBe(500)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(body).not.toContain("synthetic raw database detail")
      expect(JSON.parse(body)).toMatchObject({
        status: 500,
        type: "https://auth.eruoo.me/problems/internal-error",
      })
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "InvalidStoredDatabaseBackupHealthError",
          event: "database_backup_status_data_invalid",
        }),
      )
    } finally {
      errorLog.mockRestore()
    }
  })
})

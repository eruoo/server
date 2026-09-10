import { env, introspectWorkflowInstance } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"

import { getDatabaseBackupStatus } from "../../src/worker/backup/health"

const signedUrl = "https://signed.example/database.sql"

function activeExport() {
  return Response.json(
    {
      success: true,
      result: {
        at_bookmark: "bookmark-1",
        status: "active",
        success: true,
        type: "export",
      },
    },
    { status: 202 },
  )
}

function exportedDatabase() {
  return Response.json({
    success: true,
    result: {
      at_bookmark: "bookmark-1",
      status: "complete",
      result: { filename: "database.sql", signed_url: signedUrl },
    },
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await env.DB.prepare("DELETE FROM database_backup_health").run()
  await env.DB.prepare("DELETE FROM maintenance_lease").run()
})

it.each([
  {
    phase: "start",
    status: 403,
    attempts: 1,
    code: "backup_export_authentication_failed",
  },
  {
    phase: "start",
    status: 503,
    attempts: 1,
    code: "backup_export_request_failed",
  },
  {
    phase: "poll",
    status: 403,
    attempts: 1,
    code: "backup_export_authentication_failed",
  },
  {
    phase: "poll",
    status: 503,
    attempts: 2,
    code: "backup_export_request_failed",
  },
  {
    phase: "download",
    status: 403,
    attempts: 1,
    code: "backup_export_download_failed",
  },
  {
    phase: "download",
    status: 503,
    attempts: 2,
    code: "backup_export_download_failed",
  },
])(
  "bounds $phase $status attempts and preserves its terminal cause",
  async (scenario) => {
    let attempts = 0
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (
        scenario.phase === "poll" &&
        !String(init?.body).includes("current_bookmark")
      ) {
        return Promise.resolve(activeExport())
      }
      if (scenario.phase === "download" && request.url !== signedUrl) {
        return Promise.resolve(exportedDatabase())
      }
      attempts += 1
      return Promise.resolve(new Response(null, { status: scenario.status }))
    })

    const id = crypto.randomUUID()
    await using instance = await introspectWorkflowInstance(
      env.DATABASE_BACKUP_WORKFLOW,
      id,
    )
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays()
      await modifier.disableSleeps()
    })
    await env.DATABASE_BACKUP_WORKFLOW.create({ id })
    await instance.waitForStatus("errored")

    expect.soft(attempts).toBe(scenario.attempts)
    expect(await getDatabaseBackupStatus(env.DB)).toMatchObject({
      status: "failed",
      errorCode: scenario.code,
    })
  },
)

it("polls an active export to completion and retries one transient download failure", async () => {
  let downloads = 0
  const exportRequests: unknown[] = []
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url !== signedUrl) {
      exportRequests.push(JSON.parse(String(init?.body)))
      return Promise.resolve(
        exportRequests.length < 3 ? activeExport() : exportedDatabase(),
      )
    }
    downloads += 1
    return Promise.resolve(
      downloads === 1
        ? new Response(null, { status: 503 })
        : new Response("SELECT 1;", { headers: { "Content-Length": "9" } }),
    )
  })
  const id = crypto.randomUUID()
  await using instance = await introspectWorkflowInstance(
    env.DATABASE_BACKUP_WORKFLOW,
    id,
  )
  await instance.modify(async (modifier) => {
    await modifier.disableRetryDelays()
    await modifier.disableSleeps()
  })
  await env.DATABASE_BACKUP_WORKFLOW.create({ id })
  await instance.waitForStatus("complete")
  const output = (await instance.getOutput()) as {
    key: string
    rawBytes: number
  }
  try {
    expect(exportRequests).toEqual([
      { output_format: "polling" },
      { output_format: "polling", current_bookmark: "bookmark-1" },
      { output_format: "polling", current_bookmark: "bookmark-1" },
    ])
    expect(downloads).toBe(2)
    expect(output.rawBytes).toBe(9)
    expect(await (await env.BACKUPS.get(output.key))?.text()).toBe("SELECT 1;")
    expect((await getDatabaseBackupStatus(env.DB)).status).toBe("ok")
  } finally {
    await env.BACKUPS.delete(output.key)
  }
})

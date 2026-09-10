import { cleanupExpiredOAuthTokenState } from "./oauth/cleanup"
export async function cleanupExpiredRecords(
  database: D1Database,
  scheduledTime: number,
) {
  if (
    !Number.isSafeInteger(scheduledTime) ||
    !Number.isFinite(new Date(scheduledTime).getTime())
  )
    throw new Error("Invalid cleanup boundary")
  const jobs = [
    {
      table: "security_audit_events",
      column: "occurredAt",
      boundary: scheduledTime - 180 * 86400000,
    },
    {
      table: "verification",
      column: "expiresAt",
      boundary: new Date(scheduledTime).toISOString(),
    },
    {
      table: "rateLimit",
      column: "lastRequest",
      boundary: scheduledTime - 86400000,
    },
  ]
  for (const { table, column, boundary } of jobs) {
    for (let batch = 0; batch < 10; batch++) {
      const result = await database
        .prepare(
          `DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE "${column}" < ? LIMIT 500)`,
        )
        .bind(boundary)
        .run()
      if (result.meta.changes < 500) break
      if (batch === 9)
        console.warn(JSON.stringify({ event: "cleanup_backlog", table }))
    }
  }
}

export const DAILY_CLEANUP_SCHEDULE = "0 20 * * *"
export async function runScheduledMaintenance(
  controller: ScheduledController,
  env: Env,
) {
  if (controller.cron === DAILY_CLEANUP_SCHEDULE) {
    try {
      await cleanupExpiredOAuthTokenState(env.DB, controller.scheduledTime)
      await cleanupExpiredRecords(env.DB, controller.scheduledTime)
    } catch (error) {
      console.error({ event: "scheduled_cleanup_failed" })
      throw error
    }
    return
  }
  if (controller.cron === "0 19 * * *") {
    if (
      !Number.isSafeInteger(controller.scheduledTime) ||
      controller.scheduledTime < 0
    )
      throw new Error("Invalid backup schedule")
    await env.DATABASE_BACKUP_WORKFLOW.createBatch([
      { id: `database-backup-v1-${controller.scheduledTime}`, params: {} },
    ])
    return
  }
  console.warn(JSON.stringify({ event: "unknown_cron" }))
}

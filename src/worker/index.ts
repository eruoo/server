import { createApp } from "./app"
import { cleanupExpiredOAuthTokenState } from "./auth/oauth-token-cleanup"
import { deleteExpiredVerifications } from "./auth/verification-cleanup"
import { deleteExpiredAuditEvents } from "./modules/audit/repository"
import { DAILY_CLEANUP_SCHEDULE } from "./schedules"

export { DatabaseBackupWorkflow } from "./workflows/database-backup"

const app = createApp()

export default {
  fetch(request, env, context) {
    return app.fetch(request, env, context)
  },
  async scheduled(controller, env) {
    const requestId = crypto.randomUUID()

    if (controller.cron !== DAILY_CLEANUP_SCHEDULE) {
      console.warn({
        cron: controller.cron,
        event: "unknown_scheduled_trigger",
        requestId,
      })
      return
    }

    try {
      const cleanupResults = await Promise.allSettled([
        deleteExpiredAuditEvents(env.DB, controller.scheduledTime),
        cleanupExpiredOAuthTokenState(env.DB, controller.scheduledTime),
        deleteExpiredVerifications(env.DB, controller.scheduledTime),
      ])
      const failure = cleanupResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      if (failure) throw failure.reason
    } catch (error) {
      console.error({
        event: "scheduled_cleanup_failed",
        error: error instanceof Error ? error.name : "unknown_error",
        requestId,
      })
      throw error
    }
  },
} satisfies ExportedHandler<Env>

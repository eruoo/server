/**
 * M0 平台事实核查探针。
 *
 * 目的:在真实 Workers Free + D1 环境实测上一轮实现中"文档快照与平台
 * 现实不符"的关键数值,为 v2 设计提供实测依据:
 *
 * 1. D1 查询延迟(热/冷)——cron 每 5 分钟 SELECT 1,wallTimeMs 由
 *    Workers Logs 记录,观察闲置唤醒与热查询的分布差异。
 * 2. CPU 预算——梯度哈希负载,结合日志 cpuTimeMs 与实际限制行为。
 * 3. 请求链路基线——health 端点给出无 D1 依赖的纯函数参考。
 *
 * 不包含任何业务逻辑或凭证,可随时销毁。
 */

interface Env {
  DB: D1Database
}

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        headers: jsonHeaders,
        status: 405,
      })
    }

    if (url.pathname === "/probe/health") {
      return new Response(
        JSON.stringify({
          probe: "health",
          ok: true,
          time: new Date().toISOString(),
        }),
        { headers: jsonHeaders },
      )
    }

    if (url.pathname === "/probe/d1") {
      const startedAt = Date.now()
      const result = await env.DB.prepare("SELECT 1 AS ok").first()
      const elapsedMs = Date.now() - startedAt
      return new Response(
        JSON.stringify({
          probe: "d1",
          elapsedMs,
          result,
        }),
        { headers: jsonHeaders },
      )
    }

    if (url.pathname === "/probe/cpu") {
      const iterations = Math.min(
        Math.max(Number(url.searchParams.get("n") ?? 1000), 1),
        200_000,
      )
      const encoder = new TextEncoder()
      const startedAt = Date.now()
      let digestHead = 0
      for (let index = 0; index < iterations; index += 1) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(`probe-${index}`),
        )
        digestHead = new Uint8Array(digest)[0] ?? 0
      }
      const elapsedMs = Date.now() - startedAt
      return new Response(
        JSON.stringify({
          probe: "cpu",
          iterations,
          elapsedMs,
          digestHead,
        }),
        { headers: jsonHeaders },
      )
    }

    return new Response(JSON.stringify({ error: "not_found" }), {
      headers: jsonHeaders,
      status: 404,
    })
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // 跨 I/O 边界的 Date.now() 计时有效(workerd 时间在 I/O 边界前进),
    // 查询耗时直接写入日志,便于从 Workers Logs 读冷/热分布。
    // 平台记录的 wallTimeMs/cpuTimeMs 作为第二数据源交叉验证。
    // 2026-09-04 14:4x 起改为查询 probe_session 表(模拟 Better Auth session
    // 行形态,含表页缓存开销),比 SELECT 1 更贴近 get-session 实况。
    const startedAt = Date.now()
    const result = await env.DB.prepare(
      "SELECT id, user_id, expires_at FROM probe_session WHERE id = ?",
    )
      .bind("probe-fixed-row")
      .first()
    const elapsedMs = Date.now() - startedAt
    ctx.waitUntil(
      Promise.resolve(
        console.log(
          JSON.stringify({
            probe: "cron-d1-session",
            scheduledAt: controller.scheduledTime,
            elapsedMs,
            found: result !== null,
          }),
        ),
      ),
    )
  },
} satisfies ExportedHandler<Env>

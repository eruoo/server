/**
 * M1 技术预验(不进入 v2 交付物):验证 `wrangler deploy --env staging`
 * 的 env 解析路径——name 覆盖、D1 binding、observability 继承。
 * dry-run 不部署、不消耗凭证。
 */

interface Env {
  DB: D1Database
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    return Response.json({
      ok: true,
      hasDb: "DB" in env,
    })
  },
} satisfies ExportedHandler<Env>

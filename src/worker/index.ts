import { Hono } from "hono"

/**
 * v2 工程入口（M1 骨架）：仅 /health 端点。
 * Env 类型由 `wrangler types` 生成的 worker-configuration.d.ts 全局提供
 * （改 wrangler.jsonc 后需重跑 `pnpm exec wrangler types --env staging`）。
 * 后续里程碑按 refactoring.md 逐个叠加认证/OAuth/API 能力。
 */

const app = new Hono<{ Bindings: Env }>()

app.get("/health", (c) => {
  return c.json(
    {
      ok: true,
      service: "eruoo-server",
      milestone: "M1",
      version: c.env.CF_VERSION_METADATA?.tag ?? c.env.CF_VERSION_METADATA?.id,
      time: new Date().toISOString(),
    },
    200,
    { "cache-control": "no-store" },
  )
})

app.notFound((c) => c.json({ error: "not_found" }, 404))

export default {
  fetch: (request, env, context) => app.fetch(request, env, context),
} satisfies ExportedHandler<Env>

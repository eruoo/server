import { Hono } from "hono"

import { createAuth, type WorkerAuthConfig } from "./auth"
import { createResolvedInstanceGetter } from "./auth/initialized-instance-cache"
import { applyReadTimeout, usesApplicationTimeout } from "./timeout"

/**
 * v2 工程入口(M2:认证核心)。
 * Env 类型由 `wrangler types` 生成的 worker-configuration.d.ts 全局提供
 * (改 wrangler.jsonc 后需重跑 `pnpm run types:generate`)。
 */

function readAuthConfig(env: Env): WorkerAuthConfig {
  return {
    appOrigin: env.APP_ORIGIN,
    betterAuthSecrets: env.BETTER_AUTH_SECRETS,
    githubClientId: env.GITHUB_CLIENT_ID,
    githubClientSecret: env.GITHUB_CLIENT_SECRET,
    ownerGitHubId: env.OWNER_GITHUB_ID,
  }
}

const getInitializedAuth = createResolvedInstanceGetter((env: Env) =>
  createAuth(readAuthConfig(env), env.DB),
)

const app = new Hono<{ Bindings: Env }>()

// D1 挂起防御:读路径 5s 快速失败(先于路由匹配,覆盖所有 /api/* 读)。
app.use(async (c, next) => {
  if (usesApplicationTimeout(c.req.method, c.req.path)) {
    return applyReadTimeout(c, next)
  }
  return next()
})

app.get("/health", (c) => {
  return c.json(
    {
      ok: true,
      service: "eruoo-server",
      milestone: "M2",
      version: c.env.CF_VERSION_METADATA?.tag ?? c.env.CF_VERSION_METADATA?.id,
      time: new Date().toISOString(),
    },
    200,
    { "cache-control": "no-store" },
  )
})

app.all("/api/auth/*", async (c) => {
  const auth = await getInitializedAuth(c.env)
  return auth.handler(c.req.raw)
})

app.notFound((c) => c.json({ error: "not_found" }, 404))

export default {
  fetch: (request, env, context) => app.fetch(request, env, context),
} satisfies ExportedHandler<Env>

import type { MiddlewareHandler } from "hono"
import { csrf } from "hono/csrf"

import { inspectCredentialCarriers } from "../auth/carriers"
import { getRuntimeConfig } from "../config"
import type { AppBindings } from "./types"

export const configuredCsrf: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  if (context.req.path.startsWith("/api/auth/")) {
    await next()
    return
  }

  const inspection = inspectCredentialCarriers(context.req.raw)
  if (inspection.invalid) {
    // Route authentication owns the canonical 400 response (and any
    // route-specific Bearer challenge) for malformed or mixed carriers.
    await next()
    return
  }

  if (!inspection.carriers.includes("session")) {
    await next()
    return
  }

  const config = getRuntimeConfig(context.env)
  const middleware = csrf({
    origin: config.appOrigin,
    secFetchSite: ["same-origin", "none"],
  })

  return middleware(context, next)
}

import type { MiddlewareHandler } from "hono"

import type { AppBindings } from "./types"

const requestIdPattern = /^[A-Za-z0-9._:-]{1,64}$/

export const requestId: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const incoming = context.req.header("x-request-id")
  const value =
    incoming && requestIdPattern.test(incoming) ? incoming : crypto.randomUUID()

  context.set("requestId", value)
  await next()
  context.header("x-request-id", value)
}

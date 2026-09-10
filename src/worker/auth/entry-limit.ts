import type { Context } from "hono"

import { problem } from "../http/response"
import type { AppBindings } from "../http/types"

export async function limitAuthEntry(
  c: Context<AppBindings>,
  operation: string,
  limiter = c.env.AUTH_RATE_LIMITER,
  timeoutMs = 5000,
): Promise<ReturnType<typeof problem> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      limiter.limit({
        key: `${operation}:${c.req.header("cf-connecting-ip") ?? "local"}`,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (!result) return problem("service-unavailable", c.get("requestId"))
    if (!result.success) {
      const response = problem("rate-limit-exceeded", c.get("requestId"))
      response.headers.set("retry-after", "60")
      return response
    }
  } catch {
    return problem("service-unavailable", c.get("requestId"))
  } finally {
    clearTimeout(timer)
  }
}

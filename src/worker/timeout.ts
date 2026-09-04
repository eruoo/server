import { HTTPException } from "hono/http-exception"
import { timeout } from "hono/timeout"

/**
 * M0 结论(platform-facts.md §3):D1 查询挂起是平台间歇现象
 * (wall 30s+/cpu 1-6ms),防御必须保留。读路径 5 秒快速失败,
 * 避免挂起请求占满浏览器并发池拖垮整个 SPA。
 */
const safeReadTimeout = timeout(
  5_000,
  new HTTPException(504, { message: "The request timed out." }),
)

/**
 * 超时保护范围(与旧工程语义等价):
 * - get-session:始终保护(高频读路径,D1 挂起时最先受影响)
 * - GET/HEAD /api/*:保护(读路径)
 * - /api/auth/* 其余:不保护(OAuth 回调等写路径让流程走完,
 *   Better Auth 内部状态由 D1 storeStateStrategy 保证一致性)
 */
export function usesApplicationTimeout(method: string, path: string): boolean {
  if (method === "GET" && path === "/api/auth/get-session") {
    return true
  }

  return (
    (method === "GET" || method === "HEAD") &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/auth/")
  )
}

export function applyReadTimeout(
  context: Parameters<typeof safeReadTimeout>[0],
  next: () => Promise<void>,
) {
  return safeReadTimeout(context, next)
}

/**
 * Better Auth HTTP handler 的持久限流在应用网关下不再自动生效：网关调用
 * auth.api.* 服务端 API，绕过 router 的 onRequest 计数。本模块在同一个
 * rateLimit 表上复刻既有策略（固定窗口 + 最后请求时间），使已登记的
 * API Key 管理 operation 保持 100 次 / 60 秒的持久限流。
 */
import type { BetterAuthOptions } from "better-auth"
import { getIP } from "better-auth/api"

export const AUTH_RATE_LIMIT_WINDOW_SECONDS = 60
export const AUTH_RATE_LIMIT_MAX_REQUESTS = 100

/** Better Auth 的 basePath；桶键与库的 createRateLimitKey 对齐。 */
export const AUTH_BASE_PATH = "/api/auth"

const NO_TRUSTED_IP = "no-trusted-ip"

export interface PersistentRateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * 限流桶只由已登记的 operation 与可信 IP 组成，不包含原始 URL 或 query，
 * 避免调用方通过任意参数扩大桶数量。路径使用 Better Auth 的
 * `normalizePathname(url, basePath)` 结果，使同一 IP 的同一路径与原生
 * HTTP handler 共享持久桶。
 */
export function authRateLimitBucketKey(
  operation: string,
  trustedIp: string,
): string {
  const separator = operation.indexOf(" ")
  const path = separator < 0 ? operation : operation.slice(separator + 1)
  const relativePath = path.startsWith(`${AUTH_BASE_PATH}/`)
    ? path.slice(AUTH_BASE_PATH.length)
    : path
  return `${trustedIp}|${relativePath}`
}

/**
 * 复用 Better Auth 公开的 getIP：它按 advanced.ipAddress 配置读取允许的
 * 平台头（当前只配置 cf-connecting-ip），只接受单值有效地址，把
 * IPv4 映射地址还原为 IPv4，并把 IPv6 按默认 /64 子网归并；无法解析时
 * 测试/开发环境回退 localhost，生产回退共享桶。与原生 HTTP handler 使用
 * 同一函数与同一 options，保证两侧分桶一致。
 */
export function trustedRateLimitIp(
  request: Request,
  options: BetterAuthOptions,
): string {
  return getIP(request, options) ?? NO_TRUSTED_IP
}

/**
 * 单条 UPSERT 原子完成计数与判定，与 better-auth 的数据库限流语义一致：
 * 距上次请求满一个窗口时重置计数，否则在低于上限时递增；并发请求不会
 * 同时通过同一个残留读数。
 */
export async function consumeAuthRateLimit(
  database: D1Database,
  bucketKey: string,
  options: { maxRequests?: number; windowSeconds?: number; now?: number } = {},
): Promise<PersistentRateLimitDecision> {
  const maxRequests = options.maxRequests ?? AUTH_RATE_LIMIT_MAX_REQUESTS
  const windowMs =
    (options.windowSeconds ?? AUTH_RATE_LIMIT_WINDOW_SECONDS) * 1_000
  const now = options.now ?? Date.now()
  const row = await database
    .prepare(
      `INSERT INTO rateLimit (id, key, count, lastRequest)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN excluded.lastRequest - rateLimit.lastRequest >= ? THEN 1
           ELSE rateLimit.count + 1
         END,
         lastRequest = excluded.lastRequest
       WHERE rateLimit.count < ? OR excluded.lastRequest - rateLimit.lastRequest >= ?
       RETURNING lastRequest`,
    )
    .bind(crypto.randomUUID(), bucketKey, now, windowMs, maxRequests, windowMs)
    .first<{ lastRequest: number | bigint }>()
  if (row) return { allowed: true, retryAfterSeconds: 0 }

  const stored = await database
    .prepare("SELECT lastRequest FROM rateLimit WHERE key=?")
    .bind(bucketKey)
    .first<{ lastRequest: number | bigint }>()
  // 桶行已被并发清理时视为空桶放行，不把清理竞态当成拒绝。
  if (!stored) return { allowed: true, retryAfterSeconds: 0 }
  const lastRequest =
    typeof stored.lastRequest === "bigint"
      ? Number(stored.lastRequest)
      : stored.lastRequest
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((lastRequest + windowMs - now) / 1_000),
    ),
  }
}

import { env } from "cloudflare:test"
import { beforeEach, expect, it } from "vitest"

import { createAuth } from "../../src/worker/auth"
import {
  authRateLimitBucketKey,
  consumeAuthRateLimit,
  trustedRateLimitIp,
} from "../../src/worker/auth/persistent-rate-limit"

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rateLimit").run()
})

/** 与生产相同的 Better Auth options（含 advanced.ipAddress 配置）。 */
function authOptions() {
  return createAuth(
    {
      appOrigin: env.APP_ORIGIN,
      betterAuthSecrets: env.BETTER_AUTH_SECRETS,
      githubClientId: env.GITHUB_CLIENT_ID,
      githubClientSecret: env.GITHUB_CLIENT_SECRET,
      ownerGitHubId: env.OWNER_GITHUB_ID,
    },
    env.DB,
  ).options
}

function requestWithIp(ip?: string) {
  return new Request("http://local.test/api/auth/api-key/list", {
    headers: ip === undefined ? {} : { "cf-connecting-ip": ip },
  })
}

it("counts one bucket up to the limit and reports retry-after", async () => {
  const key = authRateLimitBucketKey(
    "GET /api/auth/api-key/list",
    "198.51.100.7",
  )
  const now = 1_700_000_000_000
  const rule = { maxRequests: 3, windowSeconds: 60, now }
  for (let attempt = 0; attempt < 3; attempt += 1)
    expect(await consumeAuthRateLimit(env.DB, key, rule)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    })

  const denied = await consumeAuthRateLimit(env.DB, key, rule)
  expect(denied.allowed).toBe(false)
  expect(denied.retryAfterSeconds).toBe(60)
  // 拒绝不递增计数，也不推进窗口。
  expect(
    await env.DB.prepare("SELECT count FROM rateLimit WHERE key=?")
      .bind(key)
      .first("count"),
  ).toBe(3)
})

it("resets the window only after the configured gap", async () => {
  const key = authRateLimitBucketKey(
    "POST /api/auth/api-key/create",
    "198.51.100.8",
  )
  const start = 1_700_000_000_000
  expect(
    (
      await consumeAuthRateLimit(env.DB, key, {
        maxRequests: 1,
        windowSeconds: 60,
        now: start,
      })
    ).allowed,
  ).toBe(true)

  const denied = await consumeAuthRateLimit(env.DB, key, {
    maxRequests: 1,
    windowSeconds: 60,
    now: start + 30_000,
  })
  expect(denied.allowed).toBe(false)
  expect(denied.retryAfterSeconds).toBe(30)

  expect(
    (
      await consumeAuthRateLimit(env.DB, key, {
        maxRequests: 1,
        windowSeconds: 60,
        now: start + 60_000,
      })
    ).allowed,
  ).toBe(true)
})

it("keeps concurrent counting atomic", async () => {
  const key = authRateLimitBucketKey(
    "POST /api/auth/api-key/update",
    "198.51.100.9",
  )
  const decisions = await Promise.all(
    Array.from({ length: 12 }, () =>
      consumeAuthRateLimit(env.DB, key, {
        maxRequests: 4,
        windowSeconds: 60,
      }),
    ),
  )
  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4)
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(8)
  expect(
    await env.DB.prepare("SELECT count FROM rateLimit WHERE key=?")
      .bind(key)
      .first("count"),
  ).toBe(4)
})

it("derives buckets from the registered operation and trusted IP only", () => {
  expect(
    authRateLimitBucketKey("GET /api/auth/api-key/list", "203.0.113.5"),
  ).toBe("203.0.113.5|/api-key/list")
  expect(
    authRateLimitBucketKey("POST /api/auth/api-key/create", "203.0.113.5"),
  ).toBe("203.0.113.5|/api-key/create")
})

it("resolves client IPs exactly like the native handler", () => {
  const options = authOptions()
  const subnet = "2001:0db8:1234:5678:0000:0000:0000:0000"
  // getIP 无法解析时返回 null，网关与原生 handler 都退化为共享桶
  // （Node 的 dev/test 环境才会回退 localhost）。
  const fallback = "no-trusted-ip"
  const cases: [string | undefined, string][] = [
    ["2001:db8:1234:5678::1", subnet],
    ["2001:db8:1234:5678::2", subnet],
    ["2001:DB8:1234:5678:0:0:0:1", subnet],
    ["2001:0db8:1234:5678:0000:0000:0000:0002", subnet],
    ["2001:db8:1234:9999::1", "2001:0db8:1234:9999:0000:0000:0000:0000"],
    ["203.0.113.5", "203.0.113.5"],
    ["::ffff:203.0.113.5", "203.0.113.5"],
    ["not-an-ip", fallback],
    ["203.0.113.5, 203.0.113.6", fallback],
    [undefined, fallback],
  ]
  const mismatches = cases
    .map(([ip, expected]) => ({
      ip,
      expected,
      actual: trustedRateLimitIp(requestWithIp(ip), options),
    }))
    .filter(({ expected, actual }) => expected !== actual)
  expect(mismatches).toEqual([])

  // 同一 /64 共享桶，不同 /64 分开。
  expect(
    trustedRateLimitIp(requestWithIp("2001:db8:1234:5678::1"), options),
  ).toBe(trustedRateLimitIp(requestWithIp("2001:db8:1234:5678::ffff"), options))
  expect(
    trustedRateLimitIp(requestWithIp("2001:db8:1234:5678::1"), options),
  ).not.toBe(
    trustedRateLimitIp(requestWithIp("2001:db8:1234:9999::1"), options),
  )
})

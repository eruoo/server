import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { isOwnerAuthenticationSource } from "../../src/worker/auth"

/**
 * M2 认证核心测试。
 *
 * 覆盖:
 * 1. Better Auth 1.7.2 在 workerd 下可初始化(ALS patch 退役验证——
 *    实例 $context 初始化无异常即证明上游 #10855 修复生效)。
 * 2. owner 准入:仅 GitHub numeric ID 匹配的 OAuth source 允许。
 * 3. get-session 无凭证时返回 null(空 session 语义)。
 */

const OWNER_GITHUB_ID = "50254496"

describe("owner admission (isOwnerAuthenticationSource)", () => {
  it("accepts the owner GitHub numeric id", () => {
    expect(
      isOwnerAuthenticationSource(
        {
          method: "oauth",
          oauth: { providerId: "github", profile: { id: 50254496 } },
        },
        OWNER_GITHUB_ID,
      ),
    ).toBe(true)

    expect(
      isOwnerAuthenticationSource(
        {
          method: "oauth",
          oauth: { providerId: "github", profile: { id: "50254496" } },
        },
        OWNER_GITHUB_ID,
      ),
    ).toBe(true)
  })

  it("rejects other GitHub accounts", () => {
    expect(
      isOwnerAuthenticationSource(
        {
          method: "oauth",
          oauth: { providerId: "github", profile: { id: 12345 } },
        },
        OWNER_GITHUB_ID,
      ),
    ).toBe(false)
  })

  it("rejects non-github oauth providers", () => {
    expect(
      isOwnerAuthenticationSource(
        {
          method: "oauth",
          oauth: { providerId: "google", profile: { id: 50254496 } },
        },
        OWNER_GITHUB_ID,
      ),
    ).toBe(false)
  })

  it("rejects non-oauth methods and missing profile ids", () => {
    expect(
      isOwnerAuthenticationSource({ method: "credentials" }, OWNER_GITHUB_ID),
    ).toBe(false)
    expect(
      isOwnerAuthenticationSource(
        { method: "oauth", oauth: { providerId: "github" } },
        OWNER_GITHUB_ID,
      ),
    ).toBe(false)
  })
})

describe("M2 auth endpoints", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it("initializes Better Auth under workerd and answers get-session", async () => {
    const response = await SELF.fetch("http://local.test/api/auth/get-session")

    expect(response.status).toBe(200)
    // Better Auth 协议事实:无凭证时 get-session 返回 200 + null body
    // (而非 { session: null });按实测行为断言。
    const body = (await response.json()) as unknown
    expect(body).toBeNull()
  })

  it("keeps disabled single-user paths unavailable", async () => {
    const response = await SELF.fetch(
      "http://local.test/api/auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "intruder@example.com",
          password: "password12345678",
          name: "intruder",
        }),
      },
    )

    expect([404, 405]).toContain(response.status)
  })
})

describe("M2 read-timeout defense", () => {
  it("still serves get-session under the 5s timeout middleware", async () => {
    const response = await SELF.fetch("http://local.test/api/auth/get-session")
    expect(response.status).toBe(200)
  })
})

import { SELF, env } from "cloudflare:test"
import { describe, expect, it } from "vitest"

/**
 * M1 冒烟:worker 在真实 workerd 运行时可启动并响应 /health。
 * D1 binding 可用性一并验证（SELECT 1）。
 */

describe("M1 skeleton health", () => {
  it("responds ok with version metadata on /health", async () => {
    const response = await SELF.fetch("https://example.com/health")
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      ok: boolean
      service: string
      milestone: string
    }
    expect(body.ok).toBe(true)
    expect(body.service).toBe("eruoo-server")
    expect(body.milestone).toBe("M2")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("returns 404 problem json for unknown paths", async () => {
    const response = await SELF.fetch("https://example.com/unknown")
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe("not_found")
  })

  it("has a working D1 binding", async () => {
    const result = await env.DB.prepare("SELECT 1 AS ok").first()
    expect(result?.ok).toBe(1)
  })
})

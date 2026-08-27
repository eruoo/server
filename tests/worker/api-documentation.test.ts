import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"

import { createApp } from "../../src/worker/app"
import { createOpenApiDocument } from "../../src/worker/openapi"
import { createOwnerSession } from "./fixtures/owner-session"

const documentationPaths = ["/api/docs", "/api/openapi.json"] as const

describe("owner API documentation", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session"),
      env.DB.prepare("DELETE FROM account"),
      env.DB.prepare("DELETE FROM user"),
    ])
  })

  it.each(documentationPaths)(
    "requires an owner Session for %s",
    async (path) => {
      const response = await SELF.fetch(`http://local.test${path}`)

      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toMatchObject({
        status: 401,
        title: "Authentication required",
        type: "https://auth.eruoo.me/problems/authentication-required",
      })
    },
  )

  it.each(documentationPaths)(
    "does not accept API keys or OAuth access tokens for %s",
    async (path) => {
      for (const headers of [
        { "x-api-key": "synthetic" },
        { authorization: "Bearer synthetic.token" },
      ]) {
        const response = await SELF.fetch(`http://local.test${path}`, {
          headers,
        })

        expect(response.status).toBe(401)
      }
    },
  )

  it("rejects ambiguous Session and Bearer carriers before rendering", async () => {
    const response = await SELF.fetch("http://local.test/api/docs", {
      headers: {
        authorization: "Bearer synthetic.token",
        cookie: "eruoo.session_token=synthetic",
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      type: "https://auth.eruoo.me/problems/invalid-request",
    })
  })

  it("returns the private runtime OpenAPI 3.1 document to the owner", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch("http://local.test/api/openapi.json", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })
    const document = await response.json()
    const generatedDocument = createOpenApiDocument(createApp())

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(document).toEqual(generatedDocument)
    expect(document).toMatchObject({
      components: {
        schemas: {
          Problem: {
            additionalProperties: false,
            properties: {
              type: {
                format: "uri",
                pattern:
                  "^https:\\/\\/auth\\.eruoo\\.me\\/problems\\/[a-z0-9]+(?:-[a-z0-9]+)*$",
                type: "string",
              },
            },
          },
          ValidationIssue: {
            additionalProperties: false,
          },
        },
      },
      openapi: "3.1.0",
    })
    expect(document).not.toHaveProperty("paths./api/docs")
    expect(document).not.toHaveProperty("paths./api/openapi.json")
    expect(document).not.toHaveProperty("paths./problems/{slug}")
    expect(JSON.stringify(document)).not.toContain("about:blank")
  })

  it("renders Scalar from the fixed same-origin asset under a nonce CSP", async () => {
    const cookie = await createOwnerSession()
    const response = await SELF.fetch("http://local.test/api/docs", {
      headers: { cookie: `eruoo.session_token=${cookie}` },
    })
    const html = await response.text()
    const contentSecurityPolicy = response.headers.get(
      "content-security-policy",
    )
    const nonce = contentSecurityPolicy?.match(
      /script-src 'self' 'nonce-([^']+)'/,
    )?.[1]

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(contentSecurityPolicy).toContain("style-src 'self' 'unsafe-inline'")
    expect(nonce).toBeTruthy()
    expect(html).toContain("<title>eruoo API Reference</title>")
    expect(html).toContain('src="/scalar/1.65.1/standalone.js"')
    expect(html).not.toContain("cdn.jsdelivr.net")
    expect(html).toContain('property="csp-nonce"')
    expect(html).toContain(`content="${nonce}"`)
    expect(html).toContain('"url": "/api/openapi.json"')
    expect(html).toContain('"hideTestRequestButton": true')
    expect(html).toContain('"persistAuth": false')
    expect(html).toContain('"withDefaultFonts": false')
    expect(html).toContain('"disabled": true')

    const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map(
      ([tag]) => tag,
    )
    expect(scriptTags).toHaveLength(2)
    expect(scriptTags.every((tag) => tag.includes(`nonce="${nonce}"`))).toBe(
      true,
    )
  })

  it.each(documentationPaths)(
    "keeps the trailing-slash variant of %s closed",
    async (path) => {
      const cookie = await createOwnerSession()
      const response = await SELF.fetch(`http://local.test${path}/`, {
        headers: { cookie: `eruoo.session_token=${cookie}` },
      })

      expect(response.status).toBe(404)
    },
  )
})

import { SELF } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import {
  problemTypeRegistry,
  type ProblemSlug,
} from "../../src/worker/http/problem-registry"

const expectedProblemTypes = {
  "api-key-expiration-required": ["API key expiration required", 422],
  "authentication-required": ["Authentication required", 401],
  conflict: ["Conflict", 409],
  "insufficient-permission": ["Insufficient permission", 403],
  "insufficient-scope": ["Insufficient scope", 403],
  "internal-error": ["Internal server error", 500],
  "invalid-credential": ["Invalid credential", 401],
  "invalid-request": ["Invalid request", 400],
  "not-found": ["Not found", 404],
  "payload-too-large": ["Payload too large", 413],
  "permission-denied": ["Permission denied", 403],
  "rate-limit-exceeded": ["Too many requests", 429],
  "recent-authentication-required": ["Recent authentication required", 403],
  "request-timeout": ["Request timeout", 504],
  "service-unavailable": ["Service unavailable", 503],
  "unsupported-media-type": ["Unsupported media type", 415],
  "validation-failed": ["Request validation failed", 422],
} as const satisfies Record<ProblemSlug, readonly [string, number]>

const expectedProblemTypeEntries = Object.entries(expectedProblemTypes) as [
  ProblemSlug,
  (typeof expectedProblemTypes)[ProblemSlug],
][]

describe("Problem type registry", () => {
  it("keeps the complete initial slug, title, and status contract stable", () => {
    expect(
      Object.fromEntries(
        Object.entries(problemTypeRegistry).map(([slug, definition]) => [
          slug,
          [definition.title, definition.status],
        ]),
      ),
    ).toEqual(expectedProblemTypes)
  })

  it.each(expectedProblemTypeEntries)(
    "publishes static documentation for %s without runtime data",
    async (slug, [title, status]) => {
      const response = await SELF.fetch(`http://local.test/problems/${slug}`)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(body).toEqual({
        description: problemTypeRegistry[slug].description,
        status,
        title,
        type: `https://auth.eruoo.me/problems/${slug}`,
      })
      expect(body).not.toHaveProperty("requestId")
    },
  )

  it("returns an empty 404 for an unknown or trailing-slash type path", async () => {
    const unknown = await SELF.fetch(
      "http://local.test/problems/not-registered",
    )
    const trailingSlash = await SELF.fetch(
      "http://local.test/problems/not-found/",
    )

    expect(unknown.status).toBe(404)
    expect(await unknown.text()).toBe("")
    expect(trailingSlash.status).toBe(404)
  })

  it.each([
    ["the local Session cookie", "eruoo.session_token=synthetic"],
    ["the secure Session cookie", "__Secure-eruoo.session_token=synthetic"],
  ])("ignores %s on public static documentation", async (_, cookie) => {
    const response = await SELF.fetch("http://local.test/problems/not-found", {
      headers: { cookie },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    await expect(response.json()).resolves.toEqual({
      description: problemTypeRegistry["not-found"].description,
      status: 404,
      title: "Not found",
      type: "https://auth.eruoo.me/problems/not-found",
    })
  })

  it.each([
    ["an API key", "/problems/not-found", { "x-api-key": "synthetic" }],
    [
      "a Bearer token",
      "/problems/not-found",
      { authorization: "Bearer synthetic.token" },
    ],
    [
      "an empty Session cookie",
      "/problems/not-found",
      {
        cookie: "eruoo.session_token=",
      },
    ],
    [
      "duplicate Session cookies",
      "/problems/not-found",
      {
        cookie: "eruoo.session_token=first; eruoo.session_token=second",
      },
    ],
    [
      "both Session cookie names",
      "/problems/not-found",
      {
        cookie:
          "eruoo.session_token=first; __Secure-eruoo.session_token=second",
      },
    ],
    [
      "mixed Session and API-key credentials",
      "/problems/not-found",
      {
        cookie: "eruoo.session_token=synthetic",
        "x-api-key": "synthetic",
      },
    ],
    ["a query token", "/problems/not-found?access_token=synthetic", {}],
  ])(
    "rejects %s instead of accepting credentials",
    async (_, path, headers) => {
      const response = await SELF.fetch(`http://local.test${path}`, { headers })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        status: 400,
        title: "Invalid request",
        type: "https://auth.eruoo.me/problems/invalid-request",
      })
    },
  )
})

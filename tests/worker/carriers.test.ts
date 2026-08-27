import { describe, expect, it } from "vitest"

import {
  hasUnsupportedBodyAccessToken,
  inspectCredentialCarriers,
} from "../../src/worker/auth/carriers"

function inspect(headers?: HeadersInit, path = "/api/resource") {
  return inspectCredentialCarriers(
    new Request(`https://auth.eruoo.me${path}`, headers ? { headers } : {}),
  )
}

describe("credential carrier inspection", () => {
  it.each([
    [{ authorization: "Bearer synthetic.token" }, "bearer"],
    [{ authorization: "bearer synthetic.token" }, "bearer"],
    [{ "x-api-key": "eruoo_synthetic" }, "apiKey"],
    [{ cookie: "eruoo.session_token=synthetic" }, "session"],
  ] as const)("accepts one valid %s carrier", (headers, carrier) => {
    expect(inspect(headers)).toEqual({ carriers: [carrier], invalid: false })
  })

  it.each([
    [{ authorization: "Basic synthetic" }],
    [{ authorization: "Bearer" }],
    [{ "x-api-key": "invalid key with spaces" }],
    [{ cookie: "eruoo.session_token" }],
    [{ cookie: "__Secure-eruoo.session_token" }],
    [{ cookie: "eruoo.session_token=" }],
    [
      {
        cookie: "eruoo.session_token=first; eruoo.session_token=second",
      },
    ],
    [
      {
        authorization: "Bearer synthetic.token",
        "x-api-key": "eruoo_synthetic",
      },
    ],
  ])("rejects malformed, repeated, or mixed carriers", (headers) => {
    expect(inspect(headers).invalid).toBe(true)
  })

  it("rejects a query access token even without a header", () => {
    expect(inspect(undefined, "/api/resource?access_token=synthetic")).toEqual({
      carriers: [],
      invalid: true,
    })
  })

  it.each([
    {
      body: JSON.stringify({ access_token: "synthetic" }),
      contentType: "application/json",
      name: "JSON",
    },
    {
      body: "access_token=synthetic",
      contentType: "application/x-www-form-urlencoded",
      name: "form",
    },
  ])(
    "detects an access token in a $name body",
    async ({ body, contentType }) => {
      const request = new Request("https://auth.eruoo.me/api/resource", {
        body,
        headers: { "content-type": contentType },
        method: "POST",
      })

      await expect(hasUnsupportedBodyAccessToken(request)).resolves.toBe(true)
    },
  )

  it("does not consume a legal request body while inspecting it", async () => {
    const request = new Request("https://auth.eruoo.me/api/resource", {
      body: JSON.stringify({ name: "Status client" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    await expect(hasUnsupportedBodyAccessToken(request)).resolves.toBe(false)
    await expect(request.json()).resolves.toEqual({ name: "Status client" })
  })
})

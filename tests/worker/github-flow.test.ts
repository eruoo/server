import { env, SELF } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM rateLimit"),
  ])
})
afterEach(() => vi.restoreAllMocks())

function githubProfile(id: number) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url)
    if (
      url.origin === "https://github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      return Response.json({
        access_token: "synthetic-token",
        token_type: "bearer",
        scope: "read:user user:email",
      })
    }
    if (url.origin === "https://api.github.com" && url.pathname === "/user")
      return Response.json({
        id,
        login: "synthetic",
        name: "Synthetic",
        email: "synthetic@example.invalid",
      })
    if (
      url.origin === "https://api.github.com" &&
      url.pathname === "/user/emails"
    )
      return Response.json([
        { email: "synthetic@example.invalid", primary: true, verified: true },
      ])
    throw new Error("Unexpected outbound request")
  })
}

let nextTestClient = 1
async function login() {
  const clientIp = `192.0.2.${nextTestClient++}`
  const start = await SELF.fetch("http://local.test/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      origin: "http://local.test",
      "content-type": "application/json",
      "cf-connecting-ip": clientIp,
    },
    body: JSON.stringify({
      provider: "github",
      callbackURL: "/",
      disableRedirect: true,
    }),
  })
  expect(start.status).toBe(200)
  const result = (await start.json()) as { url: string }
  const authorize = new URL(result.url)
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
  const state = authorize.searchParams.get("state")!
  const cookies = start.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
  return SELF.fetch(
    `http://local.test/api/auth/callback/github?code=synthetic-code&state=${encodeURIComponent(state)}`,
    {
      headers: { cookie: cookies, "cf-connecting-ip": clientIp },
      redirect: "manual",
    },
  )
}

describe("real GitHub callback owner admission", () => {
  it("creates and reauthenticates only the verified owner", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {})
    githubProfile(50254496)
    const first = await login()
    expect(first.status).toBe(302)
    const codeRequest = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url]) =>
          String(url) === "https://github.com/login/oauth/access_token",
      )
    const body = new URLSearchParams(String(codeRequest?.[1]?.body))
    expect(body.get("client_id")).toBe(env.GITHUB_CLIENT_ID)
    expect(body.get("client_secret")).toBe(env.GITHUB_CLIENT_SECRET)
    expect(body.get("redirect_uri")).toBe(
      "http://local.test/api/auth/callback/github",
    )
    expect(body.get("code")).toBe("synthetic-code")
    expect(body.get("code_verifier")).toBeTruthy()
    expect(first.headers.get("set-cookie")).toContain("eruoo.session_token=")
    const second = await login()
    expect(second.headers.get("set-cookie")).toContain("eruoo.session_token=")
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM user").first("count"),
    ).toBe(1)
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM session").first(
        "count",
      ),
    ).toBe(2)
    expect(logger).not.toHaveBeenCalled()
  })

  it("rejects a non-owner through the actual handler without creating a Session", async () => {
    githubProfile(12345)
    for (let i = 0; i < 2; i++) {
      const response = await login()
      expect(response.headers.get("location")).toContain("owner_not_allowed")
      expect(response.headers.get("set-cookie") ?? "").not.toContain(
        "eruoo.session_token=",
      )
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM session").first(
        "count",
      ),
    ).toBe(0)
  })
})

it.each([
  ["incorrect_client_credentials", "incorrect_client_credentials"],
  ["bad_verification_code", "bad_verification_code"],
  ["redirect_uri_mismatch", "redirect_uri_mismatch"],
  ["untrusted response containing a secret", "oauth_error"],
])(
  "records only an allowlisted reason for GitHub %s",
  async (error, reason) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        error,
        error_description: "private provider response",
        access_token: "private-token",
      }),
    )
    const response = await login()
    expect(response.headers.get("location")).toContain("invalid_code")
    expect(response.headers.get("set-cookie") ?? "").not.toContain(
      "eruoo.session_token=",
    )
    expect(logger.mock.calls).toEqual([
      [
        {
          event: "github_code_exchange_failed",
          reason,
        },
      ],
    ])
  },
)

it("records only HTTP status for a rejected GitHub token request", async () => {
  const logger = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response("private response", { status: 403 }),
  )
  const response = await login()
  expect(response.headers.get("location")).toContain("invalid_code")
  expect(logger.mock.calls).toEqual([
    [
      {
        event: "github_code_exchange_failed",
        reason: "http_error",
        status: 403,
      },
    ],
  ])
})

it.each([301, 302, 303, 307, 308])(
  "refuses a GitHub %s redirect without forwarding credentials",
  async (status) => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {})
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        expect(new Request(input, init).redirect).toBe("manual")
        return new Response(null, {
          status,
          headers: { location: "https://redirect.invalid/credentials" },
        })
      })
    const response = await login()
    expect(response.headers.get("location")).toContain("invalid_code")
    expect(outbound).toHaveBeenCalledTimes(1)
    expect(logger.mock.calls).toEqual([
      [{ event: "github_code_exchange_failed", reason: "http_error", status }],
    ])
  },
)

it("aborts a stalled GitHub response body and does not issue a Session", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const signalFactory = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(10000)
      return timeout(20)
    })
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("GitHub deadline")),
              { once: true },
            )
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  )
  const response = await login()
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toContain("error=")
  expect(response.headers.get("set-cookie") ?? "").not.toContain(
    "eruoo.session_token=",
  )
  expect(signalFactory).toHaveBeenCalled()
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM session").first(
      "count",
    ),
  ).toBe(0)
})

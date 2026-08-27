import { afterEach, describe, expect, it, vi } from "vitest"

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function requestFromFetchCall(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) return input
  return new Request(new URL(input.toString(), window.location.origin), init)
}

function setSignedAuthorizeLocation() {
  window.history.replaceState(
    null,
    "",
    "/login?client_id=eruoo-desktop&state=original-state&ba_param=ba_param&ba_param=client_id&ba_param=state&sig=synthetic-signature&error=unsigned-error",
  )
}

function expectAuthorizeContinuation(body: Record<string, unknown>) {
  expect(new URLSearchParams(String(body["oauth_query"]))).toEqual(
    new URLSearchParams(
      "client_id=eruoo-desktop&state=original-state&ba_param=ba_param&ba_param=client_id&ba_param=state&sig=synthetic-signature",
    ),
  )
  expect(String(body["oauth_query"])).not.toContain("unsigned-error")
}

describe("authClient OAuth continuation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/")
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("supplies the signed authorize query when GitHub login starts", async () => {
    setSignedAuthorizeLocation()
    const fetchMock = vi.fn<FetchImplementation>(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ redirect: false }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const result = await authClient.signIn.social({
      callbackURL: "/",
      errorCallbackURL: "/login",
      provider: "github",
    })

    expect(result.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [input, init] = fetchMock.mock.calls[0] ?? []
    if (!input) throw new Error("The auth client did not issue a request.")
    const request = requestFromFetchCall(input, init)
    expect(new URL(request.url).pathname).toBe("/api/auth/sign-in/social")

    const body = (await request.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      callbackURL: "/",
      errorCallbackURL: "/login",
      provider: "github",
    })
    expectAuthorizeContinuation(body)
  })

  it("supplies the signed authorize query when Passkey login completes", async () => {
    setSignedAuthorizeLocation()
    const fetchMock = vi.fn<FetchImplementation>(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: "synthetic-session" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const result = await authClient.$fetch("/passkey/verify-authentication", {
      body: {
        response: {
          id: "synthetic-credential",
          rawId: "synthetic-credential",
          response: {
            authenticatorData: "synthetic-authenticator-data",
            clientDataJSON: "synthetic-client-data",
            signature: "synthetic-signature",
            userHandle: null,
          },
          type: "public-key",
        },
      },
      method: "POST",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.error).toBeNull()
    const [input, init] = fetchMock.mock.calls[0] ?? []
    if (!input) throw new Error("Passkey verification was not requested.")
    const request = requestFromFetchCall(input, init)
    expect(new URL(request.url).pathname).toBe(
      "/api/auth/passkey/verify-authentication",
    )
    expectAuthorizeContinuation(
      (await request.json()) as Record<string, unknown>,
    )
  })
})

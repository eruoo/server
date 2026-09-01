import { afterEach, describe, expect, it, vi } from "vitest"
import { effectScope } from "vue"

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function requestFromFetchCall(input: RequestInfo | URL, init?: RequestInit) {
  if (input instanceof Request) return input
  return new Request(new URL(input.toString(), window.location.origin), init)
}

function mockAuthRequestTimeout(): AbortController {
  const timeoutController = new AbortController()
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal)
  return timeoutController
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

describe("authClient", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/")
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("aborts an auth request after the configured client timeout", async () => {
    const timeoutController = mockAuthRequestTimeout()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn<FetchImplementation>(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const request = requestFromFetchCall(input, init)
          requestSignal = request.signal
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          )
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const requestOutcome = authClient
      .$fetch("/passkey/list-user-passkeys", { method: "GET" })
      .then(
        (result) => ({ error: undefined, result }),
        (error: unknown) => ({ error, result: undefined }),
      )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    timeoutController.abort(
      new DOMException("The auth request timed out.", "TimeoutError"),
    )
    const outcome = await requestOutcome

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requestSignal?.aborted).toBe(true)
    expect(outcome.result).toBeUndefined()
    expect(outcome.error).toMatchObject({ name: "TimeoutError" })
  })

  it("settles Session reads when Better Auth supplies a cancellation signal", async () => {
    const timeoutController = mockAuthRequestTimeout()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn<FetchImplementation>(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const request = requestFromFetchCall(input, init)
          requestSignal = request.signal
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          )
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const scope = effectScope()
    const session = scope.run(() => authClient.useSession())
    if (!session) throw new Error("The Session store was not created.")

    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      timeoutController.abort(
        new DOMException("The auth request timed out.", "TimeoutError"),
      )
      await vi.waitFor(() => expect(session.value.isPending).toBe(false))

      expect(requestSignal?.aborted).toBe(true)
      expect(session.value.isPending).toBe(false)
      expect(session.value.isRefetching).toBe(false)
      expect(session.value.error).toMatchObject({ name: "TimeoutError" })
    } finally {
      scope.stop()
    }
  })

  it("keeps the client timeout active while the response body is pending", async () => {
    const timeoutController = mockAuthRequestTimeout()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn<FetchImplementation>(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFromFetchCall(input, init)
        requestSignal = request.signal
        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => controller.error(request.signal.reason),
              { once: true },
            )
          },
        })

        return new Response(body, {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      },
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const requestOutcome = authClient
      .$fetch("/passkey/list-user-passkeys", { method: "GET" })
      .then(
        (result) => ({ error: undefined, result }),
        (error: unknown) => ({ error, result: undefined }),
      )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    timeoutController.abort(
      new DOMException("The auth request timed out.", "TimeoutError"),
    )
    const outcome = await requestOutcome

    expect(requestSignal?.aborted).toBe(true)
    expect(outcome.result).toBeUndefined()
    expect(outcome.error).toMatchObject({ name: "TimeoutError" })
  })

  it("preserves caller cancellation while adding the client timeout", async () => {
    const caller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn<FetchImplementation>(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const request = requestFromFetchCall(input, init)
          requestSignal = request.signal
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          )
        }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const requestOutcome = authClient
      .$fetch("/passkey/list-user-passkeys", {
        method: "GET",
        signal: caller.signal,
      })
      .then(
        (result) => ({ error: undefined, result }),
        (error: unknown) => ({ error, result: undefined }),
      )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    caller.abort()
    const outcome = await requestOutcome

    expect(requestSignal?.aborted).toBe(true)
    expect(outcome.result).toBeUndefined()
    expect(outcome.error).toMatchObject({ name: "AbortError" })
  })

  it("preserves caller cancellation while the response body is pending", async () => {
    const caller = new AbortController()
    let bodyController:
      | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
      | undefined
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn<FetchImplementation>(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFromFetchCall(input, init)
        requestSignal = request.signal

        const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            bodyController = controller
            request.signal.addEventListener(
              "abort",
              () => controller.error(request.signal.reason),
              { once: true },
            )
          },
        })

        return new Response(body, {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      },
    )
    vi.stubGlobal("fetch", fetchMock)

    const { authClient } = await import("@client/lib/auth-client")
    const requestOutcome = authClient
      .$fetch("/passkey/list-user-passkeys", {
        method: "GET",
        signal: caller.signal,
      })
      .then(
        (result) => ({ error: undefined, result }),
        (error: unknown) => ({ error, result: undefined }),
      )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    caller.abort()

    let outcome:
      | Awaited<typeof requestOutcome>
      | { error: undefined; result: "still-pending" }

    try {
      outcome = await Promise.race([
        requestOutcome,
        new Promise<{ error: undefined; result: "still-pending" }>(
          (resolve) => {
            window.setTimeout(
              () => resolve({ error: undefined, result: "still-pending" }),
              25,
            )
          },
        ),
      ])

      expect(outcome.result).toBeUndefined()
      expect(outcome.error).toMatchObject({ name: "AbortError" })
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      if (!requestSignal?.aborted) {
        bodyController?.error(new DOMException("Test cleanup", "AbortError"))
        await requestOutcome
      }
    }
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

import { afterEach, expect, it, vi } from "vitest"

import { deadlineFetch, requestJson } from "../../src/client/lib/http"
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it("aborts the response body at the deadline and does not retry", async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () =>
              controller.error(signal?.reason),
            )
          },
        }),
      )
    })
  const pending = deadlineFetch("/api/auth/get-session")
  await Promise.all([
    expect(pending).rejects.toThrow("超时"),
    vi.advanceTimersByTimeAsync(10_000),
  ])
  expect(signal?.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
})
it("preserves the stable problem type for recent authentication", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        type: "https://auth.eruoo.me/problems/recent-authentication-required",
        detail: "Authenticate again",
      },
      { status: 403 },
    ),
  )
  await expect(requestJson("/api/private")).rejects.toMatchObject({
    status: 403,
    type: "https://auth.eruoo.me/problems/recent-authentication-required",
  })
})

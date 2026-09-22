import { afterEach, expect, it, vi } from "vitest"

import {
  deleteAiConnection,
  disconnectAiConnection,
  refreshAiModels,
  saveAiCredential,
} from "../../src/client/features/ai/ai-connections"
import { updateAiKeyModelGrants } from "../../src/client/features/security/api-keys"

/**
 * Wire contract: the server rejects mutations without the exact JSON content
 * type (and the key update always carries a name), so every client mutation
 * must send them. Mocked feature modules cannot see this; fetch can.
 */
const calls: Array<{
  body: string | null
  contentType: string | undefined
  method: string
  url: string
}> = []
const fetchMock = vi.fn<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>(async (input, init) => {
  const request = new Request(input, init)
  calls.push({
    body: typeof init?.body === "string" ? init.body : null,
    contentType: request.headers.get("content-type") ?? undefined,
    method: request.method,
    url: request.url,
  })
  return Response.json({ ok: true, modelCount: 0, status: "pending" })
})
vi.stubGlobal("fetch", fetchMock)

afterEach(() => {
  calls.length = 0
  fetchMock.mockClear()
})

it("sends the JSON content type on every AI management mutation", async () => {
  const id = "11111111-1111-1111-1111-111111111111"
  await disconnectAiConnection(id)
  await deleteAiConnection(id)
  await refreshAiModels(id)
  await saveAiCredential(id, "synthetic-key", 0)

  expect(calls.map((call) => call.contentType)).toEqual(
    Array(4).fill("application/json"),
  )
  expect(calls.map((call) => call.method)).toEqual([
    "POST",
    "DELETE",
    "POST",
    "PUT",
  ])
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    `/api/ai/connections/${id}/disconnect`,
    `/api/ai/connections/${id}`,
    `/api/ai/connections/${id}/models/refresh`,
    `/api/ai/connections/${id}/credential`,
  ])
})

it("sends the key name with a grant update", async () => {
  await updateAiKeyModelGrants(
    "ai-key-id",
    "ai probe",
    "11111111-1111-1111-1111-111111111111",
    ["gpt-test"],
  )
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
    configId: "ai",
    keyId: "ai-key-id",
    connectionId: "11111111-1111-1111-1111-111111111111",
    modelIds: ["gpt-test"],
    name: "ai probe",
  })
  expect(calls[0].contentType).toBe("application/json")
})

it("gives the upstream-touching AI calls the 35 s budget from §6.1", async () => {
  // A request that only settles when its signal aborts: the abort time is the
  // observable proof of which budget the call actually used.
  const abortTimes: number[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = Date.now()
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortTimes.push(Date.now() - startedAt)
          reject(new Error("aborted"))
        })
      })
    }),
  )

  for (const call of [
    () => refreshAiModels("11111111-1111-1111-1111-111111111111"),
  ]) {
    vi.useFakeTimers()
    const pending = call().catch(() => undefined)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(abortTimes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(abortTimes).toHaveLength(1)
    // Strictly later than the generic 30 s mutation budget: the AI calls must
    // not silently fall back to it.
    expect(abortTimes[0]).toBeGreaterThan(30_000)
    expect(abortTimes[0]).toBeLessThanOrEqual(35_000)
    abortTimes.length = 0
    vi.useRealTimers()
    await pending
  }
})

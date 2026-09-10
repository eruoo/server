import { describe, expect, it, vi } from "vitest"

import {
  D1_EXPORT_MAX_POLL_DURATION_MS,
  D1_EXPORT_MAX_POLL_OBSERVATIONS,
  D1_EXPORT_POLL_INTERVAL_MS,
} from "../../src/worker/backup/constants"
import {
  completeD1ExportWithinDeadline,
  type DurableD1ExportOperations,
} from "../../src/worker/backup/export-orchestration"

const startedAtMs = 2_000_000_000_000

describe("durable D1 export polling", () => {
  it("uses durable sleeps until a terminal export result", async () => {
    const observePoll = vi
      .fn<DurableD1ExportOperations["observePoll"]>()
      .mockResolvedValueOnce({
        observedAtMs: startedAtMs + 60_100,
        progress: { bookmark: "bookmark", state: "pending" },
      })
      .mockResolvedValueOnce({
        observedAtMs: startedAtMs + 120_200,
        progress: {
          bookmark: "bookmark",
          filename: "dump.sql",
          signedUrl: "https://signed.example/dump.sql",
          state: "complete",
        },
      })
    const sleep = vi.fn<DurableD1ExportOperations["sleep"]>(async () => {})
    const operations = {
      observePoll,
      observeStart: vi.fn<DurableD1ExportOperations["observeStart"]>(
        async () => ({
          observedAtMs: startedAtMs + 100,
          progress: { bookmark: "bookmark", state: "pending" } as const,
        }),
      ),
      sleep,
    } satisfies DurableD1ExportOperations

    await expect(
      completeD1ExportWithinDeadline(operations, startedAtMs),
    ).resolves.toMatchObject({ state: "complete" })
    expect(sleep).toHaveBeenNthCalledWith(1, 0, D1_EXPORT_POLL_INTERVAL_MS)
    expect(sleep).toHaveBeenNthCalledWith(2, 1, D1_EXPORT_POLL_INTERVAL_MS)
    expect(observePoll).toHaveBeenCalledTimes(2)
  })

  it("stops after the Free-plan poll budget even if observed time does not advance", async () => {
    const observePoll = vi.fn<DurableD1ExportOperations["observePoll"]>(
      async () => ({
        observedAtMs: startedAtMs + 100,
        progress: { bookmark: "bookmark", state: "pending" },
      }),
    )
    const sleep = vi.fn<DurableD1ExportOperations["sleep"]>(async () => {})
    const operations = {
      observePoll,
      observeStart: vi.fn<DurableD1ExportOperations["observeStart"]>(
        async () => ({
          observedAtMs: startedAtMs + 100,
          progress: { bookmark: "bookmark", state: "pending" },
        }),
      ),
      sleep,
    } satisfies DurableD1ExportOperations

    await expect(
      completeD1ExportWithinDeadline(operations, startedAtMs),
    ).rejects.toThrow("backup_export_timed_out")
    expect(sleep).toHaveBeenCalledTimes(D1_EXPORT_MAX_POLL_OBSERVATIONS)
    expect(observePoll).toHaveBeenCalledTimes(D1_EXPORT_MAX_POLL_OBSERVATIONS)
  })

  it("accepts completion on the final allowed poll", async () => {
    let observedAtMs = startedAtMs
    const observePoll = vi.fn<DurableD1ExportOperations["observePoll"]>(
      async (pollIndex) => ({
        observedAtMs,
        progress:
          pollIndex === D1_EXPORT_MAX_POLL_OBSERVATIONS - 1
            ? {
                bookmark: "bookmark",
                filename: "dump.sql",
                signedUrl: "https://signed.example/dump.sql",
                state: "complete" as const,
              }
            : { bookmark: "bookmark", state: "pending" as const },
      }),
    )
    const operations = {
      observePoll,
      observeStart: vi.fn<DurableD1ExportOperations["observeStart"]>(
        async () => ({
          observedAtMs,
          progress: { bookmark: "bookmark", state: "pending" },
        }),
      ),
      sleep: vi.fn<DurableD1ExportOperations["sleep"]>(
        async (_pollIndex, durationMs) => {
          observedAtMs += durationMs
        },
      ),
    } satisfies DurableD1ExportOperations

    await expect(
      completeD1ExportWithinDeadline(operations, startedAtMs),
    ).resolves.toMatchObject({ state: "complete" })
    expect(observePoll).toHaveBeenCalledTimes(D1_EXPORT_MAX_POLL_OBSERVATIONS)
    expect(observedAtMs).toBe(
      startedAtMs +
        D1_EXPORT_MAX_POLL_OBSERVATIONS * D1_EXPORT_POLL_INTERVAL_MS,
    )
    expect(observedAtMs).toBeLessThan(
      startedAtMs + D1_EXPORT_MAX_POLL_DURATION_MS,
    )
  })

  it("stops without another API poll at the shared 15-minute deadline", async () => {
    const deadlineMs = startedAtMs + D1_EXPORT_MAX_POLL_DURATION_MS
    const observePoll = vi
      .fn<DurableD1ExportOperations["observePoll"]>()
      .mockResolvedValue({
        observedAtMs: deadlineMs,
        progress: null,
      })
    const sleep = vi.fn<DurableD1ExportOperations["sleep"]>(async () => {})
    const operations = {
      observePoll,
      observeStart: vi.fn<DurableD1ExportOperations["observeStart"]>(
        async () => ({
          observedAtMs: deadlineMs - 3_000,
          progress: { bookmark: "bookmark", state: "pending" } as const,
        }),
      ),
      sleep,
    } satisfies DurableD1ExportOperations

    await expect(
      completeD1ExportWithinDeadline(operations, startedAtMs),
    ).rejects.toThrow("backup_export_timed_out")
    expect(sleep).toHaveBeenCalledWith(0, 3_000)
    expect(observePoll).toHaveBeenCalledTimes(1)
  })

  it("fails closed if Cloudflare changes the export bookmark", async () => {
    const operations = {
      observePoll: vi.fn<DurableD1ExportOperations["observePoll"]>(
        async () => ({
          observedAtMs: startedAtMs + 60_100,
          progress: {
            bookmark: "different-bookmark",
            filename: "dump.sql",
            signedUrl: "https://signed.example/dump.sql",
            state: "complete",
          },
        }),
      ),
      observeStart: vi.fn<DurableD1ExportOperations["observeStart"]>(
        async () => ({
          observedAtMs: startedAtMs + 100,
          progress: { bookmark: "bookmark", state: "pending" },
        }),
      ),
      sleep: vi.fn<DurableD1ExportOperations["sleep"]>(async () => {}),
    } satisfies DurableD1ExportOperations

    await expect(
      completeD1ExportWithinDeadline(operations, startedAtMs),
    ).rejects.toThrow("backup_export_response_invalid")
  })
})

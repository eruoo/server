import { describe, expect, it, vi } from "vitest"

import { D1_EXPORT_MAX_POLL_DURATION_MS } from "../../src/worker/backup/constants"
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
        observedAtMs: startedAtMs + 10_100,
        progress: { bookmark: "bookmark", state: "pending" },
      })
      .mockResolvedValueOnce({
        observedAtMs: startedAtMs + 20_200,
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
    expect(sleep).toHaveBeenNthCalledWith(1, 0, 10_000)
    expect(sleep).toHaveBeenNthCalledWith(2, 1, 10_000)
    expect(observePoll).toHaveBeenCalledTimes(2)
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
          observedAtMs: startedAtMs + 10_100,
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

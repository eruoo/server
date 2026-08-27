import { describe, expect, it, vi } from "vitest"

import {
  downloadD1Export,
  pollD1Export,
  startD1Export,
  type BackupFetch,
} from "../../src/worker/backup/d1-export"

const accountId = "a".repeat(32)
const databaseId = "00000000-0000-4000-8000-000000000001"
const apiToken = "synthetic-test-token"

function exportResponse(
  result: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(
    {
      result: {
        at_bookmark: "bookmark-1",
        success: true,
        type: "export",
        ...result,
      },
      success: true,
    },
    { status },
  )
}

describe("D1 REST export client", () => {
  it("starts one complete export without dump filters", async () => {
    const fetcher = vi.fn<BackupFetch>(async () => exportResponse({}))

    await expect(
      startD1Export(fetcher, {
        accountId,
        apiToken,
        databaseId,
      }),
    ).resolves.toEqual({ bookmark: "bookmark-1", state: "pending" })

    const request = fetcher.mock.calls[0]
    expect(request?.[0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`,
    )
    expect(request?.[1]?.headers).toEqual({
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      output_format: "polling",
    })
  })

  it("parses a completed poll and never sends dump options again", async () => {
    const fetcher = vi.fn<BackupFetch>(async () =>
      exportResponse({
        result: {
          filename: "dump.sql",
          signed_url: "https://signed.example/dump.sql",
        },
        status: "complete",
      }),
    )

    await expect(
      pollD1Export(fetcher, {
        accountId,
        apiToken,
        bookmark: "bookmark-1",
        databaseId,
      }),
    ).resolves.toEqual({
      bookmark: "bookmark-1",
      filename: "dump.sql",
      signedUrl: "https://signed.example/dump.sql",
      state: "complete",
    })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      current_bookmark: "bookmark-1",
    })
  })

  it("accepts optional inner export discriminators omitted by the API", async () => {
    const fetcher = vi.fn<BackupFetch>(async () =>
      Response.json({
        result: {
          at_bookmark: "bookmark-1",
        },
        success: true,
      }),
    )

    await expect(
      startD1Export(fetcher, {
        accountId,
        apiToken,
        databaseId,
      }),
    ).resolves.toEqual({ bookmark: "bookmark-1", state: "pending" })
  })

  it.each([
    {
      response: () => new Response(null, { status: 401 }),
      expectedCode: "backup_export_authentication_failed",
    },
    {
      response: () => exportResponse({ status: "unexpected" }),
      expectedCode: "backup_export_response_invalid",
    },
    {
      response: () => exportResponse({ error: "synthetic", status: "error" }),
      expectedCode: "backup_export_failed",
    },
  ])(
    "classifies an invalid API response",
    async ({ response, expectedCode }) => {
      const fetcher = vi.fn<BackupFetch>(async () => response())

      await expect(
        startD1Export(fetcher, {
          accountId,
          apiToken,
          databaseId,
        }),
      ).rejects.toThrow(expectedCode)
    },
  )

  it("downloads only an HTTPS signed URL as a stream", async () => {
    const fetcher = vi.fn<BackupFetch>(
      async () =>
        new Response("SELECT 1;", { headers: { "Content-Length": "9" } }),
    )
    const download = await downloadD1Export(
      fetcher,
      "https://signed.example/dump.sql",
    )

    expect(download.contentLength).toBe(9)
    await expect(new Response(download.body).text()).resolves.toBe("SELECT 1;")
    await expect(
      downloadD1Export(fetcher, "http://signed.example/dump.sql"),
    ).rejects.toThrow("backup_export_download_invalid")
  })

  it.each([undefined, "0", "01", "unknown"])(
    "rejects an absent or noncanonical Content-Length: %s",
    async (contentLength) => {
      const fetcher = vi.fn<BackupFetch>(async () => {
        const headers = new Headers()
        if (contentLength !== undefined)
          headers.set("Content-Length", contentLength)
        return new Response("SELECT 1;", { headers })
      })

      await expect(
        downloadD1Export(fetcher, "https://signed.example/dump.sql"),
      ).rejects.toThrow("backup_export_download_invalid")
    },
  )
})

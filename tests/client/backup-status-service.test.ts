import {
  BackupStatusApiError,
  createBackupStatusService,
} from "@client/features/security/backup-status-service"
import {
  createEruooApiClient,
  type EruooApiFetch,
} from "@client/lib/api-client"
import { requiresAuthentication } from "@client/lib/auth-errors"
import { beforeEach, describe, expect, it, vi } from "vitest"

function jsonResponse(
  body: unknown,
  options: { contentType?: string; status?: number } = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": options.contentType ?? "application/json",
    },
    status: options.status ?? 200,
  })
}

const validStatuses = [
  {
    errorCode: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    status: "never-run",
  },
  {
    errorCode: null,
    lastAttemptAt: Date.parse("2026-08-21T03:04:05.000Z"),
    lastSuccessAt: Date.parse("2026-08-21T03:04:05.000Z"),
    status: "ok",
  },
  {
    errorCode: "backup_upload_failed",
    lastAttemptAt: Date.parse("2026-08-22T03:04:05.000Z"),
    lastSuccessAt: Date.parse("2026-08-21T03:04:05.000Z"),
    status: "failed",
  },
] as const

describe("backup status service", () => {
  const fetcher = vi.fn<EruooApiFetch>()
  const service = createBackupStatusService(createEruooApiClient(fetcher))

  beforeEach(() => {
    fetcher.mockReset()
  })

  it.each(validStatuses)(
    "strictly parses a $status backup status",
    async (status) => {
      fetcher.mockResolvedValue(jsonResponse(status))

      await expect(service.get()).resolves.toEqual(status)

      const request = fetcher.mock.calls[0]?.[0]
      expect(request?.url).toBe(
        `${window.location.origin}/api/security/backup-status`,
      )
      expect(request?.method).toBe("GET")
      expect(request?.credentials).toBe("include")
      expect(request?.headers.get("accept")).toBe(
        "application/json, application/problem+json",
      )
    },
  )

  it.each([
    {
      errorCode: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "never-run",
      unexpected: true,
    },
    {
      errorCode: "backup_upload_failed",
      lastAttemptAt: 10,
      lastSuccessAt: 10,
      status: "ok",
    },
    {
      errorCode: "unknown_backup_failure",
      lastAttemptAt: 10,
      lastSuccessAt: null,
      status: "failed",
    },
    {
      errorCode: "backup_upload_failed",
      lastAttemptAt: 10.5,
      lastSuccessAt: null,
      status: "failed",
    },
    {
      errorCode: "backup_upload_failed",
      lastAttemptAt: 8_640_000_000_000_001,
      lastSuccessAt: null,
      status: "failed",
    },
  ])("fails closed for an invalid backup status %#", async (status) => {
    fetcher.mockResolvedValue(jsonResponse(status))

    await expect(service.get()).rejects.toThrow(BackupStatusApiError)
  })

  it("preserves a canonical authentication Problem for the UI", async () => {
    fetcher.mockResolvedValue(
      jsonResponse(
        {
          detail: "The owner Session is no longer valid.",
          requestId: "synthetic-request-id",
          status: 401,
          title: "Authentication required",
          type: "https://auth.eruoo.me/problems/authentication-required",
        },
        { contentType: "application/problem+json", status: 401 },
      ),
    )

    let thrown: unknown
    try {
      await service.get()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(BackupStatusApiError)
    expect(requiresAuthentication(thrown)).toBe(true)
  })

  it("wraps network and malformed success responses as untrusted API failures", async () => {
    fetcher.mockRejectedValueOnce(new Error("network detail must stay private"))

    await expect(service.get()).rejects.toThrow("API request failed.")

    fetcher.mockResolvedValueOnce(
      jsonResponse(validStatuses[0], { contentType: "text/plain" }),
    )

    await expect(service.get()).rejects.toThrow(
      "API success response is invalid.",
    )
  })
})

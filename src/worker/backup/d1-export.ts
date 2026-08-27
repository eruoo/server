import { DatabaseBackupError } from "./errors"

export interface D1ExportComplete {
  bookmark: string
  filename: string
  signedUrl: string
  state: "complete"
}

export interface D1ExportPending {
  bookmark: string
  state: "pending"
}

export type D1ExportProgress = D1ExportComplete | D1ExportPending

export interface D1ExportDownload {
  body: ReadableStream<Uint8Array>
  contentLength: number
}

export type BackupFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

interface D1ExportResultEnvelope {
  at_bookmark?: unknown
  error?: unknown
  result?: unknown
  status?: unknown
  success?: unknown
  type?: unknown
}

function validateD1ExportEndpointIdentifiers(
  accountId: string,
  databaseId: string,
): void {
  if (
    !/^[a-f\d]{32}$/i.test(accountId) ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(
      databaseId,
    )
  ) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }
}

function createD1ExportUrl(accountId: string, databaseId: string): string {
  validateD1ExportEndpointIdentifiers(accountId, databaseId)
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseCompleteExport(
  result: D1ExportResultEnvelope,
  bookmark: string,
): D1ExportComplete {
  if (!isRecord(result.result)) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  const filename = result.result["filename"]
  const signedUrl = result.result["signed_url"]

  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    typeof signedUrl !== "string"
  ) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(signedUrl)
  } catch (error) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      cause: error,
      retryable: false,
    })
  }

  if (parsedUrl.protocol !== "https:") {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  return {
    bookmark,
    filename,
    signedUrl,
    state: "complete",
  }
}

function parseD1ExportResponse(body: unknown): D1ExportProgress {
  if (!isRecord(body) || body["success"] !== true) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  const unvalidatedResult = body["result"]
  if (!isRecord(unvalidatedResult)) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  const result: D1ExportResultEnvelope = unvalidatedResult
  if (
    (result.success !== undefined && result.success !== true) ||
    (result.type !== undefined && result.type !== "export") ||
    typeof result.at_bookmark !== "string" ||
    result.at_bookmark.length === 0
  ) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  if (result.status === "error") {
    throw new DatabaseBackupError("backup_export_failed", {
      retryable: false,
    })
  }

  if (result.status === "complete") {
    return parseCompleteExport(result, result.at_bookmark)
  }

  if (result.status !== undefined || result.error !== undefined) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  return {
    bookmark: result.at_bookmark,
    state: "pending",
  }
}

async function sendD1ExportRequest(
  fetcher: BackupFetch,
  request: {
    accountId: string
    apiToken: string
    body: Record<string, unknown>
    databaseId: string
  },
): Promise<D1ExportProgress> {
  if (request.apiToken.length === 0) {
    throw new DatabaseBackupError("backup_configuration_invalid", {
      retryable: false,
    })
  }

  let response: Response
  try {
    response = await fetcher(
      createD1ExportUrl(request.accountId, request.databaseId),
      {
        body: JSON.stringify(request.body),
        headers: {
          Authorization: `Bearer ${request.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      },
    )
  } catch (error) {
    throw new DatabaseBackupError("backup_export_request_failed", {
      cause: error,
      retryable: true,
    })
  }

  if (response.status === 401 || response.status === 403) {
    throw new DatabaseBackupError("backup_export_authentication_failed", {
      retryable: false,
    })
  }

  if (!response.ok) {
    throw new DatabaseBackupError("backup_export_request_failed", {
      retryable: response.status === 429 || response.status >= 500,
    })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      cause: error,
      retryable: false,
    })
  }

  return parseD1ExportResponse(body)
}

export async function startD1Export(
  fetcher: BackupFetch,
  request: {
    accountId: string
    apiToken: string
    databaseId: string
  },
): Promise<D1ExportProgress> {
  return sendD1ExportRequest(fetcher, {
    accountId: request.accountId,
    apiToken: request.apiToken,
    body: {
      output_format: "polling",
    },
    databaseId: request.databaseId,
  })
}

export async function pollD1Export(
  fetcher: BackupFetch,
  request: {
    accountId: string
    apiToken: string
    bookmark: string
    databaseId: string
  },
): Promise<D1ExportProgress> {
  if (request.bookmark.length === 0) {
    throw new DatabaseBackupError("backup_export_response_invalid", {
      retryable: false,
    })
  }

  return sendD1ExportRequest(fetcher, {
    accountId: request.accountId,
    apiToken: request.apiToken,
    body: {
      current_bookmark: request.bookmark,
    },
    databaseId: request.databaseId,
  })
}

async function cancelBodyQuietly(
  body: ReadableStream<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await body.cancel(reason)
  } catch {
    // Preserve the classified response-validation error.
  }
}

export async function downloadD1Export(
  fetcher: BackupFetch,
  signedUrl: string,
  timeoutMs = 60_000,
): Promise<D1ExportDownload> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(signedUrl)
  } catch (error) {
    throw new DatabaseBackupError("backup_export_download_invalid", {
      cause: error,
      retryable: false,
    })
  }

  if (
    parsedUrl.protocol !== "https:" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new DatabaseBackupError("backup_export_download_invalid", {
      retryable: false,
    })
  }

  let response: Response
  try {
    response = await fetcher(signedUrl, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new DatabaseBackupError("backup_export_download_failed", {
      cause: error,
      retryable: true,
    })
  }

  if (!response.ok) {
    throw new DatabaseBackupError("backup_export_download_failed", {
      retryable: response.status === 429 || response.status >= 500,
    })
  }

  if (response.body === null) {
    throw new DatabaseBackupError("backup_export_download_invalid", {
      retryable: false,
    })
  }

  const contentLengthHeader = response.headers.get("Content-Length")
  if (contentLengthHeader === null || !/^[1-9]\d*$/.test(contentLengthHeader)) {
    await cancelBodyQuietly(response.body, "invalid D1 export Content-Length")
    throw new DatabaseBackupError("backup_export_download_invalid", {
      retryable: false,
    })
  }

  const contentLength = Number(contentLengthHeader)
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    await cancelBodyQuietly(response.body, "invalid D1 export Content-Length")
    throw new DatabaseBackupError("backup_export_download_invalid", {
      retryable: false,
    })
  }

  return {
    body: response.body,
    contentLength,
  }
}

import { requestJson } from "../../lib/http"

/** Invocation history metadata (no inputs, outputs, images, or tokens). */
export interface AiInvocationRecord {
  apiKeyId: string
  connectionId: string
  deadlineAt: number
  effectiveStatus: string
  endedAt: number | null
  errorCode: string | null
  leaseExpiresAt: number
  requestId: string
  startedAt: number
  status: string
  upstreamModelId: string
  upstreamRequestId: string | null
  usage: string | null
}

export interface AiInvocationCursor {
  requestId: string
  startedAt: number
}

export interface AiInvocationPage {
  nextCursor: AiInvocationCursor | null
  records: AiInvocationRecord[]
}

export const AI_INVOCATION_PAGE_SIZE = 50

export async function listAiInvocations(
  signal: AbortSignal,
  cursor?: AiInvocationCursor,
): Promise<AiInvocationPage> {
  const query = new URLSearchParams({ limit: String(AI_INVOCATION_PAGE_SIZE) })
  if (cursor) {
    query.set("beforeStartedAt", String(cursor.startedAt))
    query.set("beforeRequestId", cursor.requestId)
  }
  return requestJson<AiInvocationPage>(`/api/ai/invocations?${query}`, {
    signal,
  })
}

/** The recorded usage payload's total token count, when it is present. */
export function readUsageTotalTokens(usage: string | null): number | null {
  if (usage === null) return null
  try {
    const parsed = JSON.parse(usage) as { total_tokens?: unknown }
    return typeof parsed.total_tokens === "number" &&
      Number.isSafeInteger(parsed.total_tokens)
      ? parsed.total_tokens
      : null
  } catch {
    return null
  }
}

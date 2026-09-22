import type { ProblemSlug } from "../http/problem-registry"
import {
  accessDeepSeekCredentials,
  markAiCredentialInvalid,
  type AiCredentialServiceContext,
} from "./credential-lifecycle"
import { listDeepSeekModels } from "./deepseek-connector"
import { commitAiModelSnapshot } from "./models"
import { AI_MANAGEMENT_UPSTREAM_SINGLE_CALL_MS } from "./policy"

export async function refreshDeepSeekModelCatalog(
  context: AiCredentialServiceContext,
  input: {
    connectionId: string
    requestId: string
    now: number
    deadlineAt: number
    signal?: AbortSignal
  },
): Promise<
  | { status: "committed"; modelCount: number }
  | { status: "failed"; problem: ProblemSlug }
> {
  const credentials = await accessDeepSeekCredentials(context, input)
  if (credentials.status !== "usable")
    return {
      status: "failed",
      problem:
        credentials.status === "timed-out"
          ? "request-timeout"
          : credentials.status === "connection-not-found"
            ? "not-found"
            : credentials.status === "upstream-unavailable"
              ? "ai-upstream-unavailable"
              : "ai-reauthorization-required",
    }
  const controller = new AbortController()
  const remaining = Math.min(
    AI_MANAGEMENT_UPSTREAM_SINGLE_CALL_MS,
    input.deadlineAt - Date.now(),
  )
  if (remaining <= 0 || input.signal?.aborted)
    return { status: "failed", problem: "request-timeout" }
  const timer = setTimeout(() => controller.abort(), remaining)
  try {
    const result = await listDeepSeekModels(credentials.apiKey, {
      signal: AbortSignal.any([
        controller.signal,
        ...(input.signal ? [input.signal] : []),
      ]),
    })
    if (!result.ok) {
      if (result.status === 401)
        await markAiCredentialInvalid(
          context.database,
          input.connectionId,
          credentials.connection.credentialVersion,
        )
      return { status: "failed", problem: result.problem }
    }
    if (controller.signal.aborted || input.signal?.aborted)
      return { status: "failed", problem: "request-timeout" }
    const committed = await commitAiModelSnapshot(context.database, {
      connectionId: input.connectionId,
      observedCredentialVersion: credentials.connection.credentialVersion,
      models: result.models,
      now: Date.now(),
    })
    return committed.committed
      ? { status: "committed", modelCount: committed.modelCount }
      : { status: "failed", problem: "validation-failed" }
  } finally {
    clearTimeout(timer)
  }
}

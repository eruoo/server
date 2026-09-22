import type { ProblemSlug } from "../http/problem-registry"
import { problem } from "../http/response"
import type { AiCredentialServiceContext } from "./credential-lifecycle"
import { accessDeepSeekCredentials } from "./credential-lifecycle"
import { markAiCredentialInvalid } from "./credential-lifecycle"
import { buildDeepSeekResponsesRequest } from "./deepseek-connector"
import {
  deepSeekHttpProblem,
  DEEPSEEK_DEFAULT_EFFORT,
} from "./deepseek-connector"
import { commitAiInvocationOutcome } from "./invocations"
import {
  AI_CREDENTIAL_STAGE_BUDGET_MS,
  AI_INVOCATION_FIRST_RESPONSE_BUDGET_MS,
  AI_INVOCATION_NO_DATA_INTERVAL_MS,
  AI_INVOCATION_TOTAL_DEADLINE_MS,
} from "./policy"
import type { AiTerminalInvocationStatus } from "./policy"
import {
  consumeResponsesUpstream,
  responsesFailureProblemSlug,
  type ResponsesTerminalResult,
} from "./responses-protocol"
import type { ResponsesRequestBody } from "./responses-request"
import { ResponsesSseWriter, runResponsesSsePipeline } from "./responses-sse"

/** One admitted DeepSeek invocation. Static keys are never refreshed and generation is never replayed. */
/** Stage budgets; production uses the shared policy constants. */
export interface DeepSeekResponsesBudgets {
  credentialStageMs: number
  firstResponseMs: number
  noDataIntervalMs: number
}

export interface InvokeDeepSeekResponsesInput {
  /** API key that owns the admitted invocation row. */
  apiKeyId: string
  connectionId: string
  /** Raw AI_CREDENTIAL_KEYS value; parsed on demand, never cached. */
  credentialKeys: string
  database: D1Database
  /** Absolute deadline shared by every stage of this invocation. */
  deadlineAt: number
  /** Deployment identity bound into credential ciphertexts. */
  environment: string
  request: ResponsesRequestBody
  requestId: string
  /** Client cancellation; suppresses downstream delivery. */
  signal?: AbortSignal
  /** Invocation start, recorded by the admission stage. */
  startedAt: number
  /** Upstream model id resolved from the key's model permission. */
  upstreamModelId: string
  observedCredentialVersion: number
  observedPermissionVersion: number
  /** Test-only overrides; production uses the shared policy constants. */
  budgets?: Partial<DeepSeekResponsesBudgets>
}

export interface DeepSeekResponsesDelivery {
  /** SSE stream, JSON terminal, or Problem, depending on the outcome. */
  response: Response
  /** Settles after the invocation outcome was committed. */
  settled: Promise<void>
}

const AI_INVOCATION_USAGE_MAX_LENGTH = 4_096
const AI_INVOCATION_UPSTREAM_REQUEST_ID_MAX_LENGTH = 128

function resolveBudgets(
  overrides: Partial<DeepSeekResponsesBudgets> | undefined,
): DeepSeekResponsesBudgets {
  return {
    credentialStageMs:
      overrides?.credentialStageMs ?? AI_CREDENTIAL_STAGE_BUDGET_MS,
    firstResponseMs:
      overrides?.firstResponseMs ?? AI_INVOCATION_FIRST_RESPONSE_BUDGET_MS,
    noDataIntervalMs:
      overrides?.noDataIntervalMs ?? AI_INVOCATION_NO_DATA_INTERVAL_MS,
  }
}

function withRetryAfter(response: Response, retryAfterMs: number): Response {
  const headers = new Headers(response.headers)
  headers.set(
    "retry-after",
    String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
  )
  return new Response(response.body, { headers, status: response.status })
}

function boundedUsage(usage: unknown): string | null {
  if (usage === undefined || usage === null) return null
  let serialized: string
  try {
    serialized = JSON.stringify(usage)
  } catch {
    return null
  }
  if (typeof serialized !== "string") return null
  return serialized.length <= AI_INVOCATION_USAGE_MAX_LENGTH ? serialized : null
}

function boundedUpstreamRequestId(value: string | null): string | null {
  if (value === null || value.length === 0) return null
  return value.length <= AI_INVOCATION_UPSTREAM_REQUEST_ID_MAX_LENGTH
    ? value
    : null
}

function terminalOutcome(result: ResponsesTerminalResult): {
  errorCode: string | null
  status: AiTerminalInvocationStatus
} {
  switch (result.kind) {
    case "completed":
      return { errorCode: null, status: "succeeded" }
    case "incomplete":
      return { errorCode: null, status: "incomplete" }
    case "failed":
      return {
        errorCode: responsesFailureProblemSlug(result.failure.kind),
        status: "failed",
      }
    case "protocol-failure":
      return { errorCode: "ai-upstream-protocol-error", status: "failed" }
    case "aborted":
      // A cancelled invocation says nothing about what the upstream did
      // after the cancellation; the metadata records exactly that.
      return { errorCode: null, status: "unknown" }
  }
}

/** JSON-mode body: the terminal response object of a completed call. */
function jsonTerminalResponse(response: Record<string, unknown>): Response {
  return Response.json(response, {
    headers: { "cache-control": "no-store" },
    status: 200,
  })
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
    },
    status: 200,
  })
}

export async function invokeDeepSeekResponses(
  input: InvokeDeepSeekResponsesInput,
): Promise<DeepSeekResponsesDelivery> {
  const budgets = resolveBudgets(input.budgets)
  const context: AiCredentialServiceContext = {
    credentialKeys: input.credentialKeys,
    database: input.database,
    environment: input.environment,
  }
  const clientSignal = input.signal
  const streaming = input.request.stream ?? true
  // The absolute deadline is the tighter of the caller's value and the
  // shared 300-second policy, so a caller that passes something later cannot
  // stretch the invocation.
  const effectiveDeadlineAt = Math.min(
    input.deadlineAt,
    input.startedAt + AI_INVOCATION_TOTAL_DEADLINE_MS,
  )

  const commit = async (outcome: {
    errorCode: string | null
    status: AiTerminalInvocationStatus
    upstreamRequestId?: string | null
    usage?: string | null
  }): Promise<void> => {
    const committed = await commitAiInvocationOutcome(input.database, {
      endedAt: Date.now(),
      errorCode: outcome.errorCode,
      requestId: input.requestId,
      status: outcome.status,
      upstreamRequestId: outcome.upstreamRequestId ?? null,
      usage: outcome.usage ?? null,
    })
    // `settled` promises that the outcome landed; a lost commit is an
    // invariant violation the caller must see, not a silent success.
    if (!committed.committed) {
      throw new TypeError(
        `The AI invocation outcome was not committed: ${committed.reason}`,
      )
    }
  }

  /** Commits a controlled failure and returns its Problem response. */
  const fail = async (
    slug: ProblemSlug,
    options: { retryAfterMs?: number; upstreamRequestId?: string | null } = {},
  ): Promise<DeepSeekResponsesDelivery> => {
    await commit({
      errorCode: slug,
      status: "failed",
      upstreamRequestId: options.upstreamRequestId ?? null,
    })
    const base = problem(slug, input.requestId)
    return {
      response:
        options.retryAfterMs === undefined
          ? base
          : withRetryAfter(base, options.retryAfterMs),
      settled: Promise.resolve(),
    }
  }

  // Credential reads share the invocation deadline and have a bounded stage window.
  const readCredentials = () => {
    const now = Date.now()
    const stageDeadline = Math.min(
      effectiveDeadlineAt,
      now + budgets.credentialStageMs,
    )
    return accessDeepSeekCredentials(context, {
      connectionId: input.connectionId,
      deadlineAt: stageDeadline,
      signal: clientSignal,
    })
  }

  /** Maps a non-usable credential result to its controlled problem. */
  const credentialFailure = async (
    result: Exclude<
      Awaited<ReturnType<typeof readCredentials>>,
      { status: "usable" }
    >,
  ): Promise<DeepSeekResponsesDelivery> => {
    switch (result.status) {
      case "connection-not-found":
      case "disabled":
      case "reauthentication-required":
        return fail("ai-reauthorization-required")
      case "timed-out":
        return fail("request-timeout")
      case "upstream-unavailable":
        return fail("ai-upstream-unavailable")
    }
  }

  const cancelledOrExpired =
    async (): Promise<DeepSeekResponsesDelivery | null> => {
      if (clientSignal?.aborted) {
        await commit({ errorCode: null, status: "unknown" })
        return {
          response: problem("request-timeout", input.requestId),
          settled: Promise.resolve(),
        }
      }
      return Date.now() >= effectiveDeadlineAt ? fail("request-timeout") : null
    }
  const beforeCredentials = await cancelledOrExpired()
  if (beforeCredentials) return beforeCredentials
  const first = await readCredentials()
  const afterCredentials = await cancelledOrExpired()
  if (afterCredentials) return afterCredentials
  if (first.status !== "usable") return credentialFailure(first)
  if (
    first.connection.credentialVersion !== input.observedCredentialVersion ||
    first.connection.permissionVersion !== input.observedPermissionVersion
  )
    return fail("ai-connection-changed")

  // The absolute deadline covers credential access and the single upstream call.
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(0, effectiveDeadlineAt - Date.now()),
  )
  // The streaming path outlives this function, so the deadline stays armed
  // until its stream settles; every other path releases it on return.
  let deadlineOwnedByStream = false
  let deadlineReleased = false
  const releaseDeadline = (): void => {
    if (deadlineReleased) return
    deadlineReleased = true
    clearTimeout(deadlineTimer)
  }
  // The header timeout stops when headers arrive; the total deadline remains active.
  let firstResponseTimedOut = false

  const {
    store: _store,
    parallel_tool_calls: _parallel,
    ...upstreamInput
  } = input.request
  const upstreamBody = JSON.stringify({
    ...upstreamInput,
    instructions: input.request.instructions ?? "",
    model: input.upstreamModelId,
    reasoning: input.request.reasoning ?? { effort: DEEPSEEK_DEFAULT_EFFORT },
    stream: true,
  })

  /** True once the absolute deadline has passed or the client is gone. */
  const budgetGone = (): boolean =>
    clientSignal?.aborted === true ||
    deadlineController.signal.aborted ||
    Date.now() >= effectiveDeadlineAt

  const callUpstream = async (apiKey: string) => {
    // A call whose budget is already gone is never started: the remaining
    // absolute budget and the client's cancellation are checked
    // synchronously, before the fetch, so an expired deadline costs zero
    // upstream requests.
    if (budgetGone()) {
      throw new Error("The upstream call was not started: its budget is gone.")
    }
    const request = buildDeepSeekResponsesRequest({
      apiKey,
      stream: true,
    })
    firstResponseTimedOut = false
    const firstResponseController = new AbortController()
    const firstResponseTimer = setTimeout(
      () => {
        firstResponseTimedOut = true
        firstResponseController.abort()
      },
      Math.max(0, budgets.firstResponseMs),
    )
    const signals = [
      firstResponseController.signal,
      deadlineController.signal,
      ...(clientSignal === undefined ? [] : [clientSignal]),
    ]
    try {
      return await fetch(request.url, {
        body: upstreamBody,
        headers: request.headers,
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any(signals),
      })
    } finally {
      clearTimeout(firstResponseTimer)
    }
  }

  try {
    const credentials = first
    let upstream: Response
    try {
      upstream = await callUpstream(credentials.apiKey)
    } catch {
      if (clientSignal?.aborted) {
        // The client is gone; nothing is delivered and the outcome records
        // the uncertainty about the upstream.
        await commit({ errorCode: null, status: "unknown" })
        return {
          response: problem("request-timeout", input.requestId),
          settled: Promise.resolve(),
        }
      }
      // Pre-handshake timeouts use the existing Problem (request-timeout);
      // any other transport failure is upstream unavailability.
      const timedOut = budgetGone() || firstResponseTimedOut
      return fail(timedOut ? "request-timeout" : "ai-upstream-unavailable")
    }

    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined)
      await markAiCredentialInvalid(
        input.database,
        input.connectionId,
        credentials.connection.credentialVersion,
      )
      return fail("ai-reauthorization-required")
    }

    // Captured from the response that actually served the invocation.
    const upstreamRequestId = boundedUpstreamRequestId(
      upstream.headers.get("x-request-id"),
    )

    if (!(upstream.status >= 200 && upstream.status <= 299)) {
      await upstream.body?.cancel().catch(() => undefined)
      const slug = deepSeekHttpProblem(upstream.status)
      return fail(slug, { upstreamRequestId })
    }

    const body = upstream.body
    if (body === null) {
      return fail("ai-upstream-protocol-error", { upstreamRequestId })
    }

    if (streaming) {
      const writer = new ResponsesSseWriter()
      const pipeline = runResponsesSsePipeline({
        deadlineSignal: deadlineController.signal,
        noDataIntervalMs: budgets.noDataIntervalMs,
        requestId: input.requestId,
        signal: clientSignal,
        upstream: body,
        writer,
      })
      const settled = pipeline
        .then(async (result) => {
          const outcome = terminalOutcome(result)
          await commit({
            errorCode: outcome.errorCode,
            status: outcome.status,
            upstreamRequestId,
            usage:
              result.kind === "completed" ||
              result.kind === "incomplete" ||
              result.kind === "failed"
                ? boundedUsage(result.usage)
                : null,
          })
        })
        .finally(releaseDeadline)
      deadlineOwnedByStream = true
      return { response: sseResponse(writer.stream), settled }
    }

    const result = await consumeResponsesUpstream({
      deadlineSignal: deadlineController.signal,
      noDataIntervalMs: budgets.noDataIntervalMs,
      signal: clientSignal,
      upstream: body,
    })
    const outcome = terminalOutcome(result)
    await commit({
      errorCode: outcome.errorCode,
      status: outcome.status,
      upstreamRequestId,
      usage:
        result.kind === "completed" ||
        result.kind === "incomplete" ||
        result.kind === "failed"
          ? boundedUsage(result.usage)
          : null,
    })
    switch (result.kind) {
      case "completed":
      case "incomplete":
        return {
          response: jsonTerminalResponse(result.response),
          settled: Promise.resolve(),
        }
      case "failed":
        return {
          response: problem(
            responsesFailureProblemSlug(result.failure.kind),
            input.requestId,
          ),
          settled: Promise.resolve(),
        }
      case "protocol-failure":
        return {
          response: problem("ai-upstream-protocol-error", input.requestId),
          settled: Promise.resolve(),
        }
      case "aborted":
        // The client is gone; the response is never read. The closest
        // registered problem keeps the route contract uniform.
        return {
          response: problem("request-timeout", input.requestId),
          settled: Promise.resolve(),
        }
      default: {
        // Exhaustiveness guard: adding a terminal kind without handling it
        // here fails to compile instead of silently returning nothing.
        const exhaustive: never = result
        throw new TypeError(`Unhandled terminal result: ${String(exhaustive)}`)
      }
    }
  } finally {
    if (!deadlineOwnedByStream) releaseDeadline()
  }
}

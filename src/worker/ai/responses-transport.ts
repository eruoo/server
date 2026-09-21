import type { ProblemSlug } from "../http/problem-registry"
import { problem } from "../http/response"
import { buildCodexResponsesRequest } from "./codex-connector"
import type { AiCredentialServiceContext } from "./credential-lifecycle"
import { accessCodexCredentials } from "./credential-lifecycle"
import { markAiConnectionReauthenticationRequired } from "./credentials"
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
import { AiStageUpstreamBudget } from "./stage-budget"

/**
 * Network orchestration for one admitted Responses invocation.
 *
 * The admission stage (route layer, PR 7) has already authenticated the API
 * key, checked the model permission, reserved the invocation row, and read
 * and validated the request body. This module owns everything from the
 * credential read to the committed outcome:
 *
 * - Credential stage: at most 15 seconds (refresh network included at 10),
 *   always truncated by the invocation's absolute deadline. A scheduled
 *   refresh happens only when the recorded expiry is inside the lead window.
 * - Upstream call: the fixed connector address and headers; the upstream is
 *   always asked for SSE, because the JSON mode reads the same upstream
 *   events and returns the terminal response object.
 * - Budgets: 90 seconds for the upstream's response headers, 90 seconds of
 *   upstream silence, and the 300-second absolute deadline (the tighter of
 *   the caller's deadline and the shared policy). A transport timeout fails
 *   as upstream-unavailable and still delivers a terminal on a writable
 *   downstream; only the client's own abort suppresses delivery. The silence
 *   and deadline budgets are evaluated between upstream reads and events, so
 *   a downstream write blocked by backpressure suspends them until the
 *   consumer drains (or the client disconnects).
 * - A single upstream HTTP 401 before any event was streamed permits one
 *   forced credential refresh and one replay. A 401 that survives the replay
 *   marks the connection reauthentication-required: the fresh token was
 *   rejected, so the authorization itself is dead.
 * - Every terminal (including failures) commits the invocation outcome with
 *   the controlled error code, the upstream request id when the upstream
 *   provided one, and the returned usage when it is present and bounded. A
 *   commit that does not land rejects `settled` (streaming) or the returned
 *   promise (non-streaming) instead of reporting success.
 *
 * A stream-level reauthorization-required classification does not mark the
 * connection reauthentication-required: only a definitive pre-stream 401
 * (after a forced refresh) or the credential service's own refresh verdict
 * does, so a transient upstream auth glitch cannot wipe a working
 * credential.
 *
 * The caller receives the downstream response plus a `settled` promise that
 * resolves after the outcome commit. Streaming responses settle when the
 * downstream stream closes; callers must keep that promise alive with their
 * execution context and must handle its rejection.
 */

/** Stage budgets; production uses the shared policy constants. */
export interface CodexResponsesBudgets {
  credentialStageMs: number
  firstResponseMs: number
  noDataIntervalMs: number
}

export interface InvokeCodexResponsesInput {
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
  /** Test-only overrides; production uses the shared policy constants. */
  budgets?: Partial<CodexResponsesBudgets>
}

export interface CodexResponsesDelivery {
  /** SSE stream, JSON terminal, or Problem, depending on the outcome. */
  response: Response
  /** Settles after the invocation outcome was committed. */
  settled: Promise<void>
}

const AI_INVOCATION_USAGE_MAX_LENGTH = 4_096
const AI_INVOCATION_UPSTREAM_REQUEST_ID_MAX_LENGTH = 128

function resolveBudgets(
  overrides: Partial<CodexResponsesBudgets> | undefined,
): CodexResponsesBudgets {
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

export async function invokeCodexResponses(
  input: InvokeCodexResponsesInput,
): Promise<CodexResponsesDelivery> {
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
  ): Promise<CodexResponsesDelivery> => {
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

  // The stage window is per entry ("每次进入该阶段最多 15 秒"): a request
  // whose admission already consumed time must not silently lose its
  // refresh. The clock is the real one, because the credential service
  // writes these values into durable claim and expiry state.
  const readCredentials = (forceRefresh: boolean) => {
    const now = Date.now()
    const stageDeadline = Math.min(
      effectiveDeadlineAt,
      now + budgets.credentialStageMs,
    )
    return accessCodexCredentials(context, {
      connectionId: input.connectionId,
      deadlineAt: stageDeadline,
      forceRefresh,
      now,
      signal: clientSignal,
      upstream: new AiStageUpstreamBudget({ deadlineAt: stageDeadline }),
    })
  }

  /** Maps a non-usable credential result to its controlled problem. */
  const credentialFailure = async (
    result: Exclude<
      Awaited<ReturnType<typeof readCredentials>>,
      { status: "usable" }
    >,
  ): Promise<CodexResponsesDelivery> => {
    switch (result.status) {
      case "connection-not-found":
      case "disabled":
      case "reauthentication-required":
        return fail("ai-reauthorization-required")
      case "credential-busy":
        return fail("ai-credential-busy", { retryAfterMs: result.retryAfterMs })
      case "upstream-unavailable":
        return fail("ai-upstream-unavailable")
    }
  }

  const first = await readCredentials(false)
  if (first.status !== "usable") return credentialFailure(first)

  // The absolute deadline covers every stage; it is never reset by the 401
  // recovery or a replay.
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
  // A fresh controller per attempt: reusing an aborted one would kill the
  // body of a request whose headers arrived in the same turn.
  let firstResponseTimedOut = false

  const upstreamBody = JSON.stringify({
    ...input.request,
    instructions: input.request.instructions ?? "",
    model: input.upstreamModelId,
    store: false,
    stream: true,
  })

  /** True once the absolute deadline has passed or the client is gone. */
  const budgetGone = (): boolean =>
    clientSignal?.aborted === true ||
    deadlineController.signal.aborted ||
    Date.now() >= effectiveDeadlineAt

  const callUpstream = async (
    accessToken: string,
    accountId: string | null,
  ) => {
    // A call whose budget is already gone is never started: the remaining
    // absolute budget and the client's cancellation are checked
    // synchronously, before the fetch, so an expired deadline costs zero
    // upstream requests.
    if (budgetGone()) {
      throw new Error("The upstream call was not started: its budget is gone.")
    }
    const request = buildCodexResponsesRequest({
      accessToken,
      accountId,
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
        signal: AbortSignal.any(signals),
      })
    } finally {
      clearTimeout(firstResponseTimer)
    }
  }

  try {
    let credentials = first
    let upstream: Response
    try {
      upstream = await callUpstream(
        credentials.accessToken,
        credentials.accountId,
      )
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
      // One forced refresh and one replay, only before any event streamed.
      const refreshed = await readCredentials(true)
      if (refreshed.status !== "usable") return credentialFailure(refreshed)
      credentials = refreshed
      let replay: Response
      try {
        replay = await callUpstream(
          credentials.accessToken,
          credentials.accountId,
        )
      } catch {
        if (clientSignal?.aborted) {
          await commit({ errorCode: null, status: "unknown" })
          return {
            response: problem("request-timeout", input.requestId),
            settled: Promise.resolve(),
          }
        }
        const timedOut = budgetGone() || firstResponseTimedOut
        return fail(timedOut ? "request-timeout" : "ai-upstream-unavailable")
      }
      if (replay.status === 401) {
        await replay.body?.cancel().catch(() => undefined)
        // A fresh token was rejected: the authorization itself is dead. The
        // transition is bound to the version whose token was rejected, so a
        // reauthorization that landed meanwhile keeps its credentials — the
        // problem below then describes this invocation, not the stored state.
        await markAiConnectionReauthenticationRequired(input.database, {
          connectionId: input.connectionId,
          now: Date.now(),
          observedCredentialVersion: credentials.connection.credentialVersion,
        })
        return fail("ai-reauthorization-required", {
          upstreamRequestId: boundedUpstreamRequestId(
            replay.headers.get("x-request-id"),
          ),
        })
      }
      upstream = replay
    }

    // Captured from the response that actually served the invocation.
    const upstreamRequestId = boundedUpstreamRequestId(
      upstream.headers.get("x-request-id"),
    )

    if (!(upstream.status >= 200 && upstream.status <= 299)) {
      await upstream.body?.cancel().catch(() => undefined)
      // A bare upstream 429 does not prove the quota is exhausted, and 5xx is
      // transient: both are unavailability. Every other non-2xx status means
      // the fixed upstream contract did not hold.
      const slug: ProblemSlug =
        upstream.status === 429 || upstream.status >= 500
          ? "ai-upstream-unavailable"
          : "ai-upstream-protocol-error"
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
              result.kind === "completed" || result.kind === "incomplete"
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
        result.kind === "completed" || result.kind === "incomplete"
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

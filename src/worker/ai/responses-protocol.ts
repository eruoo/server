import type { ProblemSlug } from "../http/problem-registry"
import {
  AI_RESPONSES_SINGLE_EVENT_MAX_BYTES,
  AI_RESPONSES_STREAM_MAX_BYTES,
} from "./policy"

/**
 * Shared Responses-subset protocol for upstream SSE consumption.
 *
 * Both response modes (downstream SSE and downstream JSON) run the same
 * pipeline over the upstream event stream: incremental UTF-8/SSE parsing,
 * bounded per-event and cumulative reads, collection of completed
 * `response.output_item.done` items by output index, and one shared terminal
 * resolution — the terminal output is completed from the collected items the
 * same way for JSON returns and SSE terminal frames.
 *
 * Failure classification follows docs/specs/ai-service.md §6.3 and the fixed
 * CLIProxyAPI reference: `usage_limit_reached` (with a validated
 * resets_at/resets_in_seconds) is a quota exhaustion; authentication-class
 * errors mean the credential is unusable; capacity/rate-limit and other
 * controlled upstream failures are unavailability; unparseable events,
 * conflicting output completion, missing terminals, and oversize payloads
 * are protocol errors. Upstream error bodies are never surfaced.
 */

export type ResponsesProtocolErrorCode =
  | "event-oversize"
  | "stream-oversize"
  | "unparseable-event"
  | "terminal-oversize"
  | "missing-terminal"
  | "output-conflict"

export class ResponsesProtocolError extends Error {
  readonly code: ResponsesProtocolErrorCode
  constructor(code: ResponsesProtocolErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "ResponsesProtocolError"
  }
}

export interface ParsedUpstreamEvent {
  /** The `event:` field of the frame, when present. */
  event: string | null
  /** The concatenated `data:` payload (JSON text). */
  data: string
}

/**
 * Incremental SSE parser over arbitrary chunk boundaries. UTF-8 sequences
 * split across chunks are reassembled by the streaming decoder; partial
 * lines and partial events are buffered until their frames complete. The
 * per-event cap is counted in UTF-8 bytes as lines arrive, so a pending
 * event can never buffer past the cap — including one that never receives
 * its terminating blank line.
 */
export class UpstreamSseParser {
  private readonly decoder = new TextDecoder("utf-8")
  private readonly encoder = new TextEncoder()
  private readonly lineBuffer: string[] = []
  private bufferedLine = ""
  /** UTF-8 bytes of the event currently accumulating; reset at each flush. */
  private pendingEventBytes = 0

  push(chunk: Uint8Array): ParsedUpstreamEvent[] {
    const text = this.decoder.decode(chunk, { stream: true })
    const events: ParsedUpstreamEvent[] = []
    let start = 0
    while (start < text.length) {
      const newlineIndex = text.indexOf("\n", start)
      const line =
        newlineIndex === -1
          ? text.slice(start)
          : text.slice(start, newlineIndex)
      if (newlineIndex === -1) {
        this.bufferedLine += line
        this.countPendingBytes(line)
        break
      }
      const completeLine = this.bufferedLine + line
      this.bufferedLine = ""
      const carriageTrimmed = completeLine.endsWith("\r")
        ? completeLine.slice(0, -1)
        : completeLine
      // Count only the fragment that arrived in this chunk: every earlier
      // fragment of a line split across chunks was already counted when its
      // chunk ended mid-line. Counting `line` raw (a trailing "\r" included)
      // keeps the running total exactly the wire bytes of the event.
      this.countPendingBytes(line)
      this.lineBuffer.push(carriageTrimmed)
      if (carriageTrimmed === "") {
        const event = this.flushEvent()
        if (event !== null) events.push(event)
      }
      start = newlineIndex + 1
    }
    return events
  }

  /** Counts one line's UTF-8 bytes against the pending event's cap. */
  private countPendingBytes(line: string): void {
    this.pendingEventBytes += this.encoder.encode(line).byteLength
    if (this.pendingEventBytes > AI_RESPONSES_SINGLE_EVENT_MAX_BYTES) {
      throw new ResponsesProtocolError(
        "event-oversize",
        "A single upstream event exceeded the protocol size limit.",
      )
    }
  }

  /** Flushes a trailing event at EOF; a dangling partial line is dropped. */
  finish(): ParsedUpstreamEvent | null {
    this.decoder.decode()
    return this.flushEvent()
  }

  private flushEvent(): ParsedUpstreamEvent | null {
    const lines = this.lineBuffer.splice(0, this.lineBuffer.length)
    this.pendingEventBytes = 0
    let event: string | null = null
    const dataLines: string[] = []
    let sawFrame = false
    for (const line of lines) {
      if (line === "") continue
      if (line.startsWith(":")) continue
      sawFrame = true
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""))
      } else if (line.startsWith("event:")) {
        event = line.slice(6).replace(/^ /, "")
      }
      // `id:` and `retry:` frames are ignored by this protocol.
    }
    if (!sawFrame) return null
    if (dataLines.length === 0) return null
    return { data: dataLines.join("\n"), event }
  }
}

interface CollectedOutputItem {
  item: Record<string, unknown>
  outputIndex: number | null
}

export type ResponsesUpstreamFailureKind =
  | "quota-exceeded"
  | "reauthorization-required"
  | "unavailable"
  | "protocol-error"

export type ResponsesTerminalResult =
  | {
      kind: "completed"
      response: Record<string, unknown>
      usage: unknown
    }
  | {
      kind: "incomplete"
      response: Record<string, unknown>
      usage: unknown
    }
  | {
      kind: "failed"
      failure: {
        kind: ResponsesUpstreamFailureKind
        /** Validated upstream retry hint in milliseconds, when provable. */
        retryAfterMs?: number
      }
    }
  | {
      kind: "protocol-failure"
      code: ResponsesProtocolErrorCode
    }
  | {
      /** The invocation was cancelled before a terminal; no delivery is expected. */
      kind: "aborted"
    }

/** Upstream failure events per the fixed reference taxonomy. */
const quotaErrorType = "usage_limit_reached"
const authenticationErrorTokens = new Set(["invalid_api_key", "unauthorized"])

/**
 * Extracts the controlled error object of a terminal failure event. For
 * `response.failed` the error lives at `response.error` (with `error` as a
 * fallback); for `error` it is `error` itself or the top-level record.
 */
function readErrorRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const response = record.response
  if (
    typeof response === "object" &&
    response !== null &&
    !Array.isArray(response)
  ) {
    const nested = (response as Record<string, unknown>).error
    if (
      typeof nested === "object" &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      return nested as Record<string, unknown>
    }
    if (typeof nested === "string" && nested.length > 0) {
      return { message: nested }
    }
  }
  const error = record.error
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    return error as Record<string, unknown>
  }
  if (typeof error === "string" && error.length > 0) {
    return { message: error }
  }
  // Top-level forms (type/code/message directly on the event object).
  if (
    readControlledString(record, "type") !== null ||
    readControlledString(record, "code") !== null ||
    readControlledString(record, "message") !== null
  ) {
    return record
  }
  return null
}

function readControlledString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function classifyUpstreamFailure(errorRecord: Record<string, unknown>): {
  kind: ResponsesUpstreamFailureKind
  retryAfterMs?: number
} {
  const errorType = readControlledString(errorRecord, "type")
  const errorCode = readControlledString(errorRecord, "code")
  if (errorType === quotaErrorType) {
    // The quota hint is forwarded only when it is validated: a future
    // resets_at timestamp or a positive resets_in_seconds.
    const resetsAt = errorRecord.resets_at
    if (
      typeof resetsAt === "number" &&
      Number.isSafeInteger(resetsAt) &&
      resetsAt > 0
    ) {
      const retryAfterMs = resetsAt * 1_000 - Date.now()
      if (Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0) {
        return { kind: "quota-exceeded", retryAfterMs }
      }
    }
    const resetsInSeconds = errorRecord.resets_in_seconds
    if (
      typeof resetsInSeconds === "number" &&
      Number.isSafeInteger(resetsInSeconds) &&
      resetsInSeconds > 0
    ) {
      return { kind: "quota-exceeded", retryAfterMs: resetsInSeconds * 1_000 }
    }
    return { kind: "quota-exceeded" }
  }
  if (errorCode !== null && authenticationErrorTokens.has(errorCode)) {
    return { kind: "reauthorization-required" }
  }
  if (errorType === "authentication_error") {
    return { kind: "reauthorization-required" }
  }
  // Rate limits, capacity, context length, permission, and every other
  // controlled upstream failure map to unavailability; the body itself is
  // never surfaced.
  return { kind: "unavailable" }
}

function itemIdentity(item: Record<string, unknown>): {
  id?: string
  callId?: string
} {
  const id =
    typeof item.id === "string" && item.id.length > 0 ? item.id : undefined
  const callId =
    typeof item.call_id === "string" && item.call_id.length > 0
      ? item.call_id
      : undefined
  return { callId, id }
}

/**
 * Resolves the terminal output against the collected `output_item.done`
 * items. Terminal fields win: an existing output array keeps its items and
 * only gains missing entries — an item is completed in when it associates
 * unambiguously by item id, call id, or output index, and missing id fields
 * of terminal items are hydrated from the same-index collected item. A
 * collected item that collides with a different terminal item at the same
 * index, or that cannot be associated at all while the terminal output is
 * present, is a protocol conflict. Deltas never contribute to output items.
 */
export function completeResponsesOutput(
  terminalResponse: Record<string, unknown>,
  collected: readonly CollectedOutputItem[],
): Record<string, unknown> {
  const output = terminalResponse.output
  if (output !== undefined && !Array.isArray(output)) {
    throw new ResponsesProtocolError(
      "output-conflict",
      "The terminal output is not an array.",
    )
  }
  const hasOutput = Array.isArray(output) && output.length > 0
  if (!hasOutput) {
    if (collected.length === 0) return terminalResponse
    const indexed = collected
      .filter(
        (
          entry,
        ): entry is { item: Record<string, unknown>; outputIndex: number } =>
          entry.outputIndex !== null,
      )
      .sort((a, b) => a.outputIndex - b.outputIndex)
    const unindexed = collected.filter((entry) => entry.outputIndex === null)
    const items = [...indexed, ...unindexed].map((entry) => entry.item)
    return { ...terminalResponse, output: items }
  }
  const terminalItems = (output as unknown[]).filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  )
  if (terminalItems.length !== (output as unknown[]).length) {
    throw new ResponsesProtocolError(
      "output-conflict",
      "The terminal output contains non-object items.",
    )
  }

  const result: Array<Record<string, unknown>> = terminalItems.map((item) => ({
    ...item,
  }))
  const presentIds = new Set<string>()
  const presentCallIds = new Set<string>()
  for (const item of result) {
    const identity = itemIdentity(item)
    if (identity.id !== undefined) presentIds.add(identity.id)
    if (identity.callId !== undefined) presentCallIds.add(identity.callId)
  }

  for (const entry of collected) {
    const identity = itemIdentity(entry.item)
    const terminalIndex = entry.outputIndex ?? null
    if (identity.id !== undefined && presentIds.has(identity.id)) {
      assertNoIndexCollision(result, entry, identity, terminalIndex)
      continue
    }
    if (identity.callId !== undefined && presentCallIds.has(identity.callId)) {
      assertNoIndexCollision(result, entry, identity, terminalIndex)
      continue
    }
    if (terminalIndex === null) {
      // No index, and no id/call id association into the terminal output:
      // the completion is ambiguous.
      throw new ResponsesProtocolError(
        "output-conflict",
        "A completed output item cannot be associated with the terminal output.",
      )
    }
    if (terminalIndex > result.length) {
      throw new ResponsesProtocolError(
        "output-conflict",
        "A completed output item refers to an output gap.",
      )
    }
    if (terminalIndex === result.length) {
      result.push(entry.item)
      continue
    }
    const occupant = result[terminalIndex]
    const occupantIdentity = itemIdentity(occupant)
    if (occupantIdentity.id === undefined && identity.id !== undefined) {
      // Hydrate the terminal item's missing id from its same-index done item.
      if (
        occupantIdentity.callId !== undefined &&
        identity.callId !== undefined &&
        occupantIdentity.callId !== identity.callId
      ) {
        throw new ResponsesProtocolError(
          "output-conflict",
          "A completed output item conflicts with the terminal output at its index.",
        )
      }
      result[terminalIndex] = { ...occupant, id: identity.id }
      continue
    }
    if (
      occupantIdentity.id !== undefined &&
      identity.id !== undefined &&
      occupantIdentity.id !== identity.id
    ) {
      throw new ResponsesProtocolError(
        "output-conflict",
        "A completed output item conflicts with the terminal output at its index.",
      )
    }
    if (
      occupantIdentity.callId !== undefined &&
      identity.callId !== undefined &&
      occupantIdentity.callId !== identity.callId
    ) {
      throw new ResponsesProtocolError(
        "output-conflict",
        "A completed output item conflicts with the terminal output at its index.",
      )
    }
    // Same identity at the same index: the terminal item already stands.
  }
  return { ...terminalResponse, output: result }
}

function assertNoIndexCollision(
  result: readonly Record<string, unknown>[],
  entry: CollectedOutputItem,
  identity: { id?: string; callId?: string },
  terminalIndex: number | null,
): void {
  if (terminalIndex === null || terminalIndex >= result.length) return
  const occupantIdentity = itemIdentity(result[terminalIndex])
  if (
    occupantIdentity.id !== undefined &&
    identity.id !== undefined &&
    occupantIdentity.id !== identity.id
  ) {
    throw new ResponsesProtocolError(
      "output-conflict",
      "A completed output item conflicts with the terminal output at its index.",
    )
  }
  if (
    occupantIdentity.callId !== undefined &&
    identity.callId !== undefined &&
    occupantIdentity.callId !== identity.callId
  ) {
    throw new ResponsesProtocolError(
      "output-conflict",
      "A completed output item conflicts with the terminal output at its index.",
    )
  }
}

export type UpstreamFrameSink = (frame: {
  data: string
  event: string | null
}) => Promise<void> | void

/**
 * A downstream writer that owns comment heartbeats. The pipeline races its
 * upstream reads against the writer's next heartbeat deadline; heartbeats
 * never reset upstream idleness or the total deadline.
 */
export interface ResponsesHeartbeatSink {
  /** Milliseconds from now until the next heartbeat is due, or null. */
  heartbeatDelayMs(): number | null
  /**
   * Sends the heartbeat if one is due; false when nothing was sent. A
   * backpressured heartbeat waits for the buffer to drain instead of
   * returning immediately, so the pipeline never busy-polls a skipped
   * heartbeat.
   */
  sendHeartbeatIfDue(): Promise<boolean>
}

export interface ConsumeResponsesUpstreamInput {
  upstream: ReadableStream<Uint8Array>
  /** Called for every non-terminal event; awaited so backpressure propagates. */
  onEvent?: UpstreamFrameSink
  /** Optional heartbeat owner (downstream SSE mode only). */
  heartbeatSink?: ResponsesHeartbeatSink
  /** Client cancellation; yields `aborted` and delivers nothing. */
  signal?: AbortSignal
  /**
   * Upstream silence budget in milliseconds. When no body chunk arrives for
   * this long the call fails as unavailable — a transport timeout, not a
   * client abort, so a writable downstream still receives its terminal. The
   * timer starts with each awaited read and is reset by data, never by a
   * heartbeat.
   */
  noDataIntervalMs?: number
  /**
   * Absolute transport deadline. Firing it fails the call as unavailable for
   * the same reason as the silence budget; client cancellation is expressed
   * through `signal` instead.
   */
  deadlineSignal?: AbortSignal
}

class CancellableSleep {
  private timer: ReturnType<typeof setTimeout> | undefined
  readonly promise: Promise<"timer">
  constructor(delayMs: number) {
    this.promise = new Promise<"timer">((resolve) => {
      this.timer = setTimeout(() => resolve("timer"), Math.max(0, delayMs))
    })
  }
  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
  }
}

/**
 * Consumes one upstream SSE body to its single terminal, enforcing the
 * cumulative read budget and the abort signal. Non-terminal frames are
 * handed to the sink (downstream SSE forwarding or a JSON-mode no-op); the
 * terminal is resolved through the shared output completion. The returned
 * result is exactly what the JSON mode returns and what the SSE mode emits
 * as its terminal frame or error event.
 *
 * Abort is observed at loop boundaries and through the caller wiring the
 * upstream body to the same AbortSignal; without that wiring a stalled read
 * resolves only at the next heartbeat cycle (or never without a sink).
 */
export async function consumeResponsesUpstream(
  input: ConsumeResponsesUpstreamInput,
): Promise<ResponsesTerminalResult> {
  const parser = new UpstreamSseParser()
  const collected: CollectedOutputItem[] = []
  let readBytes = 0
  const reader = input.upstream.getReader()
  let terminal: ResponsesTerminalResult | null = null
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  let pendingSleep: CancellableSleep | null = null
  let pendingNoData: CancellableSleep | null = null
  const timeoutFailure = (): ResponsesTerminalResult => ({
    failure: { kind: "unavailable" },
    kind: "failed",
  })
  // The deadline is a race participant, not just a loop-boundary check: a
  // stalled read must end the call even when the runtime does not error the
  // body stream on abort.
  const deadlinePromise =
    input.deadlineSignal === undefined
      ? null
      : new Promise<"deadline">((resolve) => {
          if (input.deadlineSignal?.aborted) resolve("deadline")
          else {
            input.deadlineSignal?.addEventListener(
              "abort",
              () => resolve("deadline"),
              { once: true },
            )
          }
        })
  try {
    while (terminal === null) {
      if (input.signal?.aborted) {
        await reader.cancel()
        return { kind: "aborted" }
      }
      if (input.deadlineSignal?.aborted) {
        await reader.cancel().catch(() => undefined)
        return timeoutFailure()
      }
      const heartbeatDelay = input.heartbeatSink?.heartbeatDelayMs() ?? null
      if (heartbeatDelay === null || heartbeatDelay > 0) {
        if (pendingRead === null) {
          pendingRead = reader.read()
          // The silence budget starts with each awaited read; heartbeats
          // never reset it, so a chatty downstream cannot mask a silent
          // upstream.
          if (
            input.noDataIntervalMs !== undefined &&
            input.noDataIntervalMs > 0
          ) {
            pendingNoData = new CancellableSleep(input.noDataIntervalMs)
          }
        }
        if (heartbeatDelay === null) {
          const racers = [
            pendingRead.then((result) => ({
              kind: "read" as const,
              result,
            })),
            ...(pendingNoData === null
              ? []
              : [
                  pendingNoData.promise.then(() => ({
                    kind: "no-data" as const,
                  })),
                ]),
            ...(deadlinePromise === null
              ? []
              : [
                  deadlinePromise.then(() => ({
                    kind: "deadline" as const,
                  })),
                ]),
          ]
          const winner =
            racers.length === 1
              ? { kind: "read" as const, result: await pendingRead }
              : await Promise.race(racers)
          if (winner.kind === "no-data" || winner.kind === "deadline") {
            await reader.cancel().catch(() => undefined)
            return timeoutFailure()
          }
          pendingNoData?.cancel()
          pendingNoData = null
          pendingRead = null
          const { done, value } = winner.result
          if (done) break
          readBytes += value.byteLength
          if (readBytes > AI_RESPONSES_STREAM_MAX_BYTES) {
            await reader.cancel()
            return { kind: "protocol-failure", code: "stream-oversize" }
          }
          for (const event of parser.push(value)) {
            const outcome = await handleParsedEvent(
              event,
              collected,
              input.onEvent,
            )
            if (outcome !== null) terminal = outcome
          }
          continue
        }
        pendingSleep = new CancellableSleep(heartbeatDelay)
        const winner = await Promise.race([
          pendingRead.then((result) => ({ kind: "read" as const, result })),
          pendingSleep.promise.then(() => ({ kind: "timer" as const })),
          ...(pendingNoData === null
            ? []
            : [
                pendingNoData.promise.then(() => ({
                  kind: "no-data" as const,
                })),
              ]),
          ...(deadlinePromise === null
            ? []
            : [
                deadlinePromise.then(() => ({
                  kind: "deadline" as const,
                })),
              ]),
        ])
        pendingSleep.cancel()
        if (winner.kind === "no-data" || winner.kind === "deadline") {
          await reader.cancel().catch(() => undefined)
          return timeoutFailure()
        }
        if (winner.kind === "timer") {
          await input.heartbeatSink?.sendHeartbeatIfDue()
          continue
        }
        pendingNoData?.cancel()
        pendingNoData = null
        pendingRead = null
        const { done, value } = winner.result
        if (done) break
        readBytes += value.byteLength
        if (readBytes > AI_RESPONSES_STREAM_MAX_BYTES) {
          await reader.cancel()
          return { kind: "protocol-failure", code: "stream-oversize" }
        }
        for (const event of parser.push(value)) {
          const outcome = await handleParsedEvent(
            event,
            collected,
            input.onEvent,
          )
          if (outcome !== null) terminal = outcome
        }
        continue
      }
      // A heartbeat is due right now; send it before waiting again.
      await input.heartbeatSink?.sendHeartbeatIfDue()
    }
    if (terminal === null) {
      const trailing = parser.finish()
      if (trailing !== null) {
        terminal = await handleParsedEvent(trailing, collected, input.onEvent)
      }
    }
    if (terminal === null) {
      // EOF without a terminal: the stream cannot be completed.
      return { kind: "protocol-failure", code: "missing-terminal" }
    }
    // A terminal before EOF abandons the remaining upstream bytes and
    // releases the connection.
    await reader.cancel().catch(() => undefined)
    return terminal
  } catch (error) {
    // Every early exit releases the upstream connection, not just the reader's
    // lock: a protocol failure must not leave the upstream body open.
    await reader.cancel().catch(() => undefined)
    if (error instanceof ResponsesProtocolError) {
      return { kind: "protocol-failure", code: error.code }
    }
    if (input.signal?.aborted) {
      return { kind: "aborted" }
    }
    if (input.deadlineSignal?.aborted) {
      // The transport deadline aborted the body under this read; that is a
      // timeout, not a malformed upstream stream.
      return timeoutFailure()
    }
    // Reader errors (network drops) are abnormal stream ends.
    return { kind: "protocol-failure", code: "missing-terminal" }
  } finally {
    pendingSleep?.cancel()
    pendingNoData?.cancel()
    reader.releaseLock()
  }
}

async function handleParsedEvent(
  event: ParsedUpstreamEvent,
  collected: CollectedOutputItem[],
  onEvent: UpstreamFrameSink | undefined,
): Promise<ResponsesTerminalResult | null> {
  let payload: unknown
  try {
    payload = JSON.parse(event.data)
  } catch {
    throw new ResponsesProtocolError(
      "unparseable-event",
      "An upstream event payload is not valid JSON.",
    )
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new ResponsesProtocolError(
      "unparseable-event",
      "An upstream event payload is not an object.",
    )
  }
  const record = payload as Record<string, unknown>
  const type = readControlledString(record, "type")
  if (type === null) {
    throw new ResponsesProtocolError(
      "unparseable-event",
      "An upstream event carries no type.",
    )
  }

  if (type === "response.output_item.done") {
    const outputIndex = record.output_index
    const item = record.item
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      (outputIndex !== undefined &&
        (typeof outputIndex !== "number" ||
          !Number.isSafeInteger(outputIndex) ||
          outputIndex < 0))
    ) {
      throw new ResponsesProtocolError(
        "unparseable-event",
        "A completed output item event is malformed.",
      )
    }
    collected.push({
      item: item as Record<string, unknown>,
      outputIndex: typeof outputIndex === "number" ? outputIndex : null,
    })
    await onEvent?.({ data: event.data, event: event.event })
    return null
  }

  if (type === "response.completed" || type === "response.incomplete") {
    const response = record.response
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    ) {
      throw new ResponsesProtocolError(
        "unparseable-event",
        "A terminal response event carries no response object.",
      )
    }
    const completed = completeResponsesOutput(
      response as Record<string, unknown>,
      collected,
    )
    const serializedBytes = new TextEncoder().encode(
      JSON.stringify(completed),
    ).byteLength
    if (serializedBytes > AI_RESPONSES_SINGLE_EVENT_MAX_BYTES) {
      throw new ResponsesProtocolError(
        "terminal-oversize",
        "The completed terminal response exceeds the protocol size limit.",
      )
    }
    return {
      kind: type === "response.completed" ? "completed" : "incomplete",
      response: completed,
      usage: (completed as { usage?: unknown }).usage ?? null,
    } satisfies ResponsesTerminalResult
  }

  if (type === "response.failed" || type === "error") {
    const errorRecord = readErrorRecord(record)
    const failure = classifyUpstreamFailure(errorRecord ?? {})
    return { kind: "failed", failure } satisfies ResponsesTerminalResult
  }

  // Every other Responses event is forwarded without interpretation.
  await onEvent?.({ data: event.data, event: event.event })
  return null
}

/** Maps a protocol failure kind to its downstream problem slug. */
export function responsesFailureProblemSlug(
  failure: ResponsesUpstreamFailureKind | ResponsesProtocolErrorCode,
): ProblemSlug {
  if (failure === "quota-exceeded") return "ai-upstream-quota-exceeded"
  if (failure === "reauthorization-required")
    return "ai-reauthorization-required"
  if (failure === "unavailable") return "ai-upstream-unavailable"
  return "ai-upstream-protocol-error"
}

export { AI_RESPONSES_SINGLE_EVENT_MAX_BYTES, AI_RESPONSES_STREAM_MAX_BYTES }

import {
  AI_RESPONSES_SINGLE_EVENT_MAX_BYTES,
  AI_RESPONSES_STREAM_MAX_BYTES,
  AI_SSE_HEARTBEAT_INTERVAL_MS,
} from "../../shared/ai"
import { problem } from "../http/response"
import {
  ResponsesProtocolError,
  consumeResponsesUpstream,
  responsesFailureProblemSlug,
  type ResponsesHeartbeatSink,
  type ResponsesTerminalResult,
} from "./responses-protocol"

/**
 * Downstream SSE writer with a bounded buffer, comment heartbeats, and a
 * cumulative transfer budget.
 *
 * The writer exposes the ReadableStream handed back to the caller and a
 * `writeEvent` API used by the protocol pipeline. Producer frames wait in a
 * small internal queue; the stream pulls them on demand, and `writeEvent`
 * awaits while the queue exceeds the high-water mark, so backpressure
 * propagates to the upstream read loop instead of accumulating an unbounded
 * buffer for a slow consumer. Writes are awaited one at a time by the
 * single-writer pipeline — concurrent writeEvent calls may transiently
 * overshoot the high-water mark because each checks the buffer before its
 * own enqueue.
 * Heartbeats (`: keepalive`) are only sent when the buffer is empty — under
 * backpressure they are skipped, never queued — and they stop once the
 * stream is closed. Every byte written, heartbeats included, counts against
 * the transfer budget; a frame that would exceed it is not written and the
 * caller terminates with the single error event (allowed a bounded, small
 * overrun) and closes the stream.
 */

const SSE_HIGH_WATER_BYTES = 64 * 1_024

/**
 * Outcome of one write attempt: the frame was queued for delivery, refused by
 * the transfer budget (the caller must terminate the stream with an error
 * event), or dropped because delivery already ended — cancelled by the
 * consumer or terminated by the total deadline.
 */
export type ResponsesWriteOutcome = "written" | "budget-exceeded" | "dropped"

export class ResponsesSseWriter implements ResponsesHeartbeatSink {
  readonly stream: ReadableStream<Uint8Array>
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private readonly queue: Uint8Array[] = []
  private readonly spaceWaiters: Array<() => void> = []
  private readonly pullWaiters: Array<() => void> = []
  private readonly drainWaiters: Array<() => void> = []
  private queuedBytes = 0
  private writtenBytes = 0
  private closed = false
  private cancelled = false
  private terminated = false
  /** Set once the transfer budget can no longer admit a heartbeat. */
  private heartbeatsExhausted = false
  private lastWriteAt: number
  private readonly now: () => number
  private readonly heartbeatIntervalMs: number

  constructor(
    options: { heartbeatIntervalMs?: number; now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    // The interval is the design's 15 seconds; tests inject a short one so
    // heartbeat timing is verifiable with real timers.
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? AI_SSE_HEARTBEAT_INTERVAL_MS
    this.lastWriteAt = this.now()
    this.stream = new ReadableStream<Uint8Array>({
      cancel: () => {
        this.cancelled = true
        this.wakePullWaiters()
        this.wakeSpaceWaiters()
        this.wakeDrainWaiters()
      },
      pull: (controller) => this.pull(controller),
      start: (controller) => {
        this.controller = controller
      },
    })
  }

  private pull(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void | Promise<void> {
    this.controller = controller
    if (this.dispatch(controller)) return
    // Nothing buffered: the returned promise pends until the next enqueue,
    // which keeps the runtime from busy-pulling an idle stream.
    return new Promise<void>((resolve) => {
      this.pullWaiters.push(() => {
        resolve()
        this.dispatch(controller)
      })
    })
  }

  /** Enqueues one buffered chunk; true when something was delivered. */
  private dispatch(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean {
    const chunk = this.queue.shift()
    if (chunk === undefined) return false
    this.queuedBytes -= chunk.byteLength
    controller.enqueue(chunk)
    this.wakeSpaceWaiters()
    if (this.queue.length === 0) {
      this.wakeDrainWaiters()
    }
    if (this.closed && this.queue.length === 0) {
      this.closeController()
    }
    return true
  }

  private closeController(): void {
    try {
      this.controller?.close()
    } catch {
      // Already closed or cancelled by the runtime.
    }
    this.wakePullWaiters()
    this.wakeSpaceWaiters()
    this.wakeDrainWaiters()
  }

  private wakeDrainWaiters(): void {
    if (
      this.cancelled ||
      this.terminated ||
      this.closed ||
      this.queue.length === 0
    ) {
      const waiters = this.drainWaiters.splice(0, this.drainWaiters.length)
      for (const wake of waiters) wake()
    }
  }

  /**
   * Resolves once the internal buffer is fully drained (or the stream ends).
   * The heartbeat path uses this so a backpressured heartbeat waits for a
   * real state change instead of spinning: at most one heartbeat stays
   * pending, and it is never queued.
   */
  waitForDrain(): Promise<void> {
    if (
      this.cancelled ||
      this.terminated ||
      this.closed ||
      this.queue.length === 0
    ) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve)
    })
  }

  private wakePullWaiters(): void {
    const waiters = this.pullWaiters.splice(0, this.pullWaiters.length)
    for (const wake of waiters) wake()
  }

  private wakeSpaceWaiters(): void {
    if (
      this.cancelled ||
      this.terminated ||
      this.queuedBytes <= SSE_HIGH_WATER_BYTES
    ) {
      const waiters = this.spaceWaiters.splice(0, this.spaceWaiters.length)
      for (const wake of waiters) wake()
    }
  }

  /**
   * Resolves once the buffer is below the high-water mark, or immediately once
   * the consumer cancelled or the deadline terminated delivery.
   */
  private async awaitSpace(): Promise<void> {
    while (
      !this.cancelled &&
      !this.terminated &&
      this.queuedBytes > SSE_HIGH_WATER_BYTES
    ) {
      await new Promise<void>((resolve) => {
        this.spaceWaiters.push(resolve)
      })
    }
  }

  private enqueueBytes(bytes: Uint8Array): void {
    this.queue.push(bytes)
    this.queuedBytes += bytes.byteLength
    this.wakePullWaiters()
  }

  /**
   * Writes one event frame. Returns "budget-exceeded" when the frame would
   * exceed the transfer budget — the frame is then not written and the caller
   * must terminate the stream with an error event — and "dropped" once
   * delivery ended (consumer cancellation or the total deadline).
   */
  async writeEvent(
    event: string | null,
    data: string,
  ): Promise<ResponsesWriteOutcome> {
    if (this.closed || this.cancelled || this.terminated) return "dropped"
    const frame =
      event === null
        ? `data: ${data}\n\n`
        : `event: ${event}\ndata: ${data}\n\n`
    const bytes = new TextEncoder().encode(frame)
    if (this.writtenBytes + bytes.byteLength > AI_RESPONSES_STREAM_MAX_BYTES) {
      return "budget-exceeded"
    }
    await this.awaitSpace()
    if (this.cancelled || this.terminated) return "dropped"
    this.writtenBytes += bytes.byteLength
    this.lastWriteAt = this.now()
    this.enqueueBytes(bytes)
    return "written"
  }

  /** Bytes written so far, heartbeats included. */
  bytesWritten(): number {
    return this.writtenBytes
  }

  /**
   * Writes the single terminal error frame. The bounded, small frame is
   * allowed to slightly exceed the transfer budget by design: the
   * alternative — a terminal-less close — is indistinguishable from a
   * failure anyway, and an explicit controlled error is the contract's
   * promise. Exactly-once use per stream.
   */
  async writeTerminalError(data: string): Promise<ResponsesWriteOutcome> {
    if (this.closed || this.cancelled || this.terminated) return "dropped"
    const bytes = new TextEncoder().encode(`event: error\ndata: ${data}\n\n`)
    await this.awaitSpace()
    if (this.cancelled || this.terminated) return "dropped"
    this.writtenBytes += bytes.byteLength
    this.lastWriteAt = this.now()
    this.enqueueBytes(bytes)
    return "written"
  }

  /** Whether the consumer cancelled the stream. */
  isCancelled(): boolean {
    return this.cancelled
  }

  /** Whether the total deadline ended delivery. */
  isTerminated(): boolean {
    return this.terminated
  }

  /**
   * Ends delivery for good: pending pull/space/drain waits resolve, the buffer
   * is dropped and the stream closes, so a consumer that stopped reading can
   * no longer hold the handler open. Frames already delivered stay delivered.
   */
  terminate(): void {
    if (this.terminated || this.cancelled) return
    this.terminated = true
    this.queue.length = 0
    this.queuedBytes = 0
    this.closeController()
  }

  heartbeatDelayMs(): number | null {
    if (
      this.closed ||
      this.cancelled ||
      this.terminated ||
      this.heartbeatsExhausted
    ) {
      return null
    }
    return Math.max(0, this.lastWriteAt + this.heartbeatIntervalMs - this.now())
  }

  /**
   * Sends the comment heartbeat when one is due. Under backpressure the
   * heartbeat is never queued: the call waits until the buffer drains (or
   * delivery ends) and then sends at most this one heartbeat. Returns false
   * when no heartbeat was sent.
   */
  async sendHeartbeatIfDue(): Promise<boolean> {
    if (this.closed || this.cancelled || this.terminated) return false
    if (this.now() - this.lastWriteAt < this.heartbeatIntervalMs) return false
    if (this.queue.length > 0 || this.queuedBytes > 0) {
      await this.waitForDrain()
      if (this.closed || this.cancelled || this.terminated) return false
      if (this.queue.length > 0 || this.queuedBytes > 0) return false
    }
    const bytes = new TextEncoder().encode(": keepalive\n\n")
    if (this.writtenBytes + bytes.byteLength > AI_RESPONSES_STREAM_MAX_BYTES) {
      // The budget no longer admits heartbeats; they are not essential, and
      // refusing permanently keeps the pipeline loop from re-trying.
      this.heartbeatsExhausted = true
      return false
    }
    this.writtenBytes += bytes.byteLength
    this.lastWriteAt = this.now()
    this.enqueueBytes(bytes)
    return true
  }

  /**
   * Closes the producer side. Queued chunks drain first; subsequent reads
   * observe the end of the stream. Idempotent; no-op after cancellation.
   */
  close(): void {
    if (this.closed || this.cancelled || this.terminated) return
    this.closed = true
    if (this.queue.length === 0) {
      this.closeController()
    }
    // With chunks still queued, dispatch closes the controller after the
    // final chunk is delivered.
  }
}

/**
 * Runs the downstream SSE protocol over one upstream stream: forwards every
 * non-terminal frame, emits exactly one terminal (the completed terminal
 * event, or a sanitized `error` event), and closes the stream. Returns the
 * resolved terminal for the invocation record; a cancelled consumer still
 * yields the true terminal, only the delivery is skipped.
 *
 * Delivery is bounded by the total deadline: an abort ends delivery (the
 * writer stops accepting frames and closes the stream) so a consumer that
 * stopped reading without cancelling cannot keep the handler, and therefore
 * the outcome commit, waiting. The terminal frame is written only while the
 * stream is still writable; otherwise the stream is terminated instead of
 * waiting for space to send an error.
 */
export async function runResponsesSsePipeline(input: {
  upstream: ReadableStream<Uint8Array>
  writer: ResponsesSseWriter
  requestId: string
  signal?: AbortSignal
  /** Upstream silence budget forwarded to the shared consumer. */
  noDataIntervalMs?: number
  /** Absolute transport deadline forwarded to the shared consumer. */
  deadlineSignal?: AbortSignal
}): Promise<ResponsesTerminalResult> {
  const { writer } = input
  const stopDelivery = (): void => writer.terminate()
  input.deadlineSignal?.addEventListener("abort", stopDelivery, { once: true })
  input.signal?.addEventListener("abort", stopDelivery, { once: true })
  try {
    const result = await consumeResponsesUpstream({
      deadlineSignal: input.deadlineSignal,
      heartbeatSink: writer,
      noDataIntervalMs: input.noDataIntervalMs,
      onEvent: async (frame) => {
        const outcome = await writer.writeEvent(frame.event, frame.data)
        if (outcome === "budget-exceeded") {
          throw new ResponsesProtocolError(
            "stream-oversize",
            "The downstream SSE transfer exceeded its budget.",
          )
        }
        // "dropped": delivery already ended. The consume loop stops at its
        // next cancellation or deadline boundary and cancels the upstream.
      },
      signal: input.signal,
      upstream: input.upstream,
    })

    if (input.deadlineSignal?.aborted) {
      // The total deadline ended the call while its terminal was still in
      // flight: the invocation is a timeout, not a success.
      writer.terminate()
      return { kind: "failed", failure: { kind: "unavailable" } }
    }
    if (input.signal?.aborted) {
      // The client is gone: the invocation records an unknown outcome instead
      // of a success nobody received.
      return { kind: "aborted" }
    }
    const deliverable =
      !writer.isCancelled() && !writer.isTerminated() && !input.signal?.aborted
    if (
      (result.kind === "completed" || result.kind === "incomplete") &&
      deliverable
    ) {
      const type =
        result.kind === "completed"
          ? "response.completed"
          : "response.incomplete"
      const data = JSON.stringify({ response: result.response, type })
      if (
        new TextEncoder().encode(data).byteLength >
        AI_RESPONSES_SINGLE_EVENT_MAX_BYTES
      ) {
        await writeTerminalErrorEvent(
          writer,
          problem("ai-upstream-protocol-error", input.requestId),
        )
        writer.close()
        return { kind: "protocol-failure", code: "terminal-oversize" }
      }
      const writeOutcome = await writer.writeEvent(type, data)
      if (writeOutcome === "dropped" && writer.isTerminated()) {
        // The deadline ended delivery while the terminal frame was waiting for
        // space: the consumer never received it, so the invocation is a
        // timeout rather than a success. A consumer cancellation instead keeps
        // the true terminal — only the delivery is suppressed.
        return { kind: "failed", failure: { kind: "unavailable" } }
      }
      if (writeOutcome === "budget-exceeded") {
        await writeTerminalErrorEvent(
          writer,
          problem("ai-upstream-protocol-error", input.requestId),
        )
        writer.close()
        return { kind: "protocol-failure", code: "stream-oversize" }
      }
    } else if (result.kind === "failed" || result.kind === "protocol-failure") {
      if (deliverable) {
        const slug =
          result.kind === "failed"
            ? responsesFailureProblemSlug(result.failure.kind)
            : responsesFailureProblemSlug(result.code)
        // The error frame shares the terminal write path: if the deadline ends
        // delivery while it waits for space, the stream closes without it and
        // the caller sees an ended stream, which the contract treats as a
        // failure — never an unbounded wait for space that may never come.
        await writeTerminalErrorEvent(writer, problem(slug, input.requestId))
      }
    }
    writer.close()
    return result
  } finally {
    input.deadlineSignal?.removeEventListener("abort", stopDelivery)
    input.signal?.removeEventListener("abort", stopDelivery)
  }
}

/**
 * Writes the single sanitized error event with the bounded overrun allowance:
 * the small terminal error frame may slightly exceed the transfer budget by
 * design, because the alternative — a terminal-less close — leaves the
 * client waiting, and an explicit controlled error is the contract's promise.
 */
async function writeTerminalErrorEvent(
  writer: ResponsesSseWriter,
  errorResponse: Response,
): Promise<void> {
  const body = (await errorResponse.json()) as Record<string, unknown>
  await writer.writeTerminalError(JSON.stringify(body))
}

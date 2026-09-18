import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AI_RESPONSES_STREAM_MAX_BYTES as AI_STREAM_BUDGET,
  AI_SSE_HEARTBEAT_INTERVAL_MS,
} from "../../src/shared/ai"
import {
  UpstreamSseParser,
  completeResponsesOutput,
  consumeResponsesUpstream,
  responsesFailureProblemSlug,
  ResponsesProtocolError,
  type ResponsesTerminalResult,
} from "../../src/worker/ai/responses-protocol"
import { validateResponsesRequest } from "../../src/worker/ai/responses-request"
import {
  ResponsesSseWriter,
  runResponsesSsePipeline,
} from "../../src/worker/ai/responses-sse"

afterEach(() => vi.restoreAllMocks())

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift()
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  })
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return streamFromChunks([encode(text)])
}

function dataEvent(payload: unknown, eventName?: string): string {
  const eventLine = eventName === undefined ? "" : `event: ${eventName}\n`
  return `${eventLine}data: ${JSON.stringify(payload)}\n\n`
}

function outputItemDone(index: number, item: Record<string, unknown>): string {
  return dataEvent({
    item,
    output_index: index,
    type: "response.output_item.done",
  })
}

function terminalEvent(
  type: "response.completed" | "response.incomplete",
  response: Record<string, unknown>,
): string {
  return dataEvent({ response, type })
}

function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    content: [{ text, type: "output_text" }],
    id,
    role: "assistant",
    status: "completed",
    type: "message",
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let text = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value, { stream: true })
  }
  return text
}

describe("Responses request subset validation", () => {
  const validBase = { input: "hello", model: "codex-main/gpt-test" }

  it("accepts the complete supported subset and rejects nothing in it", () => {
    const result = validateResponsesRequest({
      ...validBase,
      include: ["reasoning.encrypted_content"],
      instructions: "be brief",
      parallel_tool_calls: true,
      reasoning: { effort: "high" },
      store: false,
      stream: false,
      text: {
        format: {
          name: "result",
          schema: { type: "object" },
          strict: true,
          type: "json_schema",
        },
      },
      tool_choice: { name: "get_weather", type: "function" },
      tools: [
        {
          description: "d",
          name: "get_weather",
          parameters: { type: "object" },
          strict: true,
          type: "function",
        },
      ],
    })
    expect(result).toMatchObject({ ok: true })
  })

  it("rejects every unsupported or unknown field instead of dropping it", () => {
    for (const extra of [
      { temperature: 0.7 },
      { max_output_tokens: 512 },
      { metadata: { a: 1 } },
      { top_p: 0.9 },
      { unknown_field: true },
      { store: true },
      { tool_choice: "required" },
      { reasoning: { effort: "high", summary: "auto" } },
      { text: { format: { type: "json_object" }, verbosity: "low" } },
      { include: ["reasoning.encrypted_content", "file_search_call.results"] },
      { tools: [{ type: "web_search" }] },
    ]) {
      const result = validateResponsesRequest({ ...validBase, ...extra })
      expect(result.ok ? -1 : result.issues.length).toBeGreaterThan(0)
    }
  })

  it("accepts multi-turn messages, inline images, and function tool flows", () => {
    const result = validateResponsesRequest({
      input: [
        {
          content: [{ text: "system text", type: "input_text" }],
          role: "system",
          type: "message",
        },
        {
          content: [
            { text: "what is this", type: "input_text" },
            {
              image_url: "data:image/png;base64,aGVsbG8=",
              type: "input_image",
            },
          ],
          role: "user",
          type: "message",
        },
        {
          arguments: '{"city":"sf"}',
          call_id: "call_1",
          name: "get_weather",
          type: "function_call",
        },
        {
          call_id: "call_1",
          output: '{"temp":18}',
          type: "function_call_output",
        },
        {
          encrypted_content: "opaque-state",
          id: "rs_1",
          summary: [{ text: "thought", type: "summary_text" }],
          type: "reasoning",
        },
        {
          content: [{ text: "earlier reply", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      ],
      model: "codex-main/gpt-test",
    })
    expect(result).toMatchObject({ ok: true })
  })

  it("rejects unsupported input items, content parts, and image sources", () => {
    const cases: unknown[] = [
      { input: [{ type: "web_search_call" }], model: "m" },
      {
        input: [
          {
            type: "message",
            role: "tool",
            content: [{ type: "input_text", text: "x" }],
          },
        ],
        model: "m",
      },
      {
        input: [
          {
            content: [{ type: "summary_text", text: "x" }],
            role: "user",
            type: "message",
          },
        ],
        model: "m",
      },
      {
        input: [
          {
            content: [
              { type: "input_image", image_url: "https://example.com/cat.png" },
            ],
            role: "user",
            type: "message",
          },
        ],
        model: "m",
      },
      {
        input: [
          {
            content: [
              {
                type: "input_image",
                image_url: "data:image/gif;base64,aGVsbG8=",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
        model: "m",
      },
      {
        input: [
          {
            content: [
              { type: "input_image", image_url: "data:image/png;base64,!!!" },
            ],
            role: "user",
            type: "message",
          },
        ],
        model: "m",
      },
      {
        input: [
          {
            content: [
              {
                type: "input_image",
                detail: "high",
                image_url: "data:image/png;base64,aGVsbG8=",
              },
            ],
            role: "user",
            type: "message",
          },
        ],
        model: "m",
      },
      { input: [], model: "m" },
      { input: [{ type: "reasoning", content: "x" }], model: "m" },
      { model: "m" },
    ]
    for (const body of cases) {
      const result = validateResponsesRequest(body)
      expect(result.ok ? -1 : result.issues.length).toBeGreaterThan(0)
    }
  })
})

describe("upstream SSE parsing", () => {
  it("reassembles events split across arbitrary chunk boundaries", () => {
    const text =
      `event: response.created\ndata: {"type":"response.created"}\n\n` +
      `: upstream keepalive\n\n` +
      `data: {"type":"response.in_progress"}\n\n`
    const parser = new UpstreamSseParser()
    const events = []
    // One byte per push: the harshest chunking.
    for (const byte of encode(text))
      events.push(...parser.push(Uint8Array.of(byte)))
    const trailing = parser.finish()
    if (trailing !== null) events.push(trailing)
    expect(events).toEqual([
      { data: '{"type":"response.created"}', event: "response.created" },
      { data: '{"type":"response.in_progress"}', event: null },
    ])
  })

  it("keeps multi-byte UTF-8 and multi-line data frames intact", () => {
    const text = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你好🌍"}\n\n`
    const parser = new UpstreamSseParser()
    const events: Array<{ data: string; event: string | null }> = []
    const bytes = encode(text)
    // Split inside the four-byte emoji code point: cut between its second
    // and third byte so the decoder must reassemble a split sequence.
    const emojiOffset = encode(text.slice(0, text.indexOf("🌍"))).length
    expect(emojiOffset).toBeGreaterThan(0)
    for (const chunk of [
      bytes.slice(0, emojiOffset + 2),
      bytes.slice(emojiOffset + 2),
    ]) {
      events.push(...parser.push(chunk))
    }
    expect(events).toEqual([
      {
        data: '{"type":"response.output_text.delta","delta":"你好🌍"}',
        event: "response.output_text.delta",
      },
    ])
  })

  it("joins multiple data lines, tolerates CRLF, and ignores id/retry frames", () => {
    const parser = new UpstreamSseParser()
    const events = parser.push(
      encode(
        'id: 1\r\nretry: 100\r\nevent: x\r\ndata: {"a":\r\ndata: 1}\r\n\r\n',
      ),
    )
    expect(events).toEqual([{ data: '{"a":\n1}', event: "x" }])
  })

  it("emits no event for comment-only or data-less frames", () => {
    const parser = new UpstreamSseParser()
    const events = parser.push(encode(": comment\n\nevent: nope\n\n"))
    expect(events).toEqual([])
  })

  it("rejects a single event beyond the per-event cap", () => {
    const parser = new UpstreamSseParser()
    const huge = "x".repeat(4 * 1_048_576 + 16)
    let caught: unknown
    try {
      parser.push(encode(`data: ${huge}\n\n`))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResponsesProtocolError)
    expect((caught as ResponsesProtocolError).code).toBe("event-oversize")
  })
})

describe("terminal output completion", () => {
  it("fills an empty terminal output with collected done items by index", () => {
    const result = completeResponsesOutput({ status: "completed" }, [
      { item: messageItem("msg_2", "second"), outputIndex: 2 },
      { item: messageItem("msg_0", "first"), outputIndex: 0 },
      { item: messageItem("msg_1", "middle"), outputIndex: 1 },
    ])
    expect(
      (result.output as Array<{ id: string }>).map((item) => item.id),
    ).toEqual(["msg_0", "msg_1", "msg_2"])
  })

  it("keeps terminal items, inserts missing ones, and hydrates missing ids", () => {
    const result = completeResponsesOutput(
      {
        output: [
          messageItem("msg_0", "first"),
          { content: [], role: "assistant", type: "message" },
        ],
        status: "completed",
      },
      [
        { item: messageItem("msg_0", "first"), outputIndex: 0 },
        { item: messageItem("msg_1", "middle"), outputIndex: 1 },
        {
          item: {
            call_id: "call_9",
            name: "f",
            arguments: "{}",
            type: "function_call",
          },
          outputIndex: 2,
        },
      ],
    )
    const output = result.output as Array<Record<string, unknown>>
    expect(output).toHaveLength(3)
    expect(output[0].id).toBe("msg_0")
    // The id-less terminal item was hydrated from its same-index done item.
    expect(output[1].id).toBe("msg_1")
    // The missing index 2 was completed in.
    expect(output[2]).toMatchObject({
      call_id: "call_9",
      type: "function_call",
    })
  })

  it("associates present items by id and call id without duplicating them", () => {
    const result = completeResponsesOutput(
      {
        output: [
          messageItem("msg_1", "at index zero upstream reordered"),
          {
            call_id: "call_9",
            name: "f",
            arguments: "{}",
            type: "function_call",
          },
        ],
        status: "completed",
      },
      [
        {
          item: messageItem("msg_1", "at index zero upstream reordered"),
          outputIndex: 1,
        },
        {
          item: {
            call_id: "call_9",
            name: "f",
            arguments: "{}",
            type: "function_call",
          },
          outputIndex: 0,
        },
      ],
    )
    expect(result.output).toHaveLength(2)
  })

  it("reports a protocol conflict when one index carries two different items", () => {
    expect(() =>
      completeResponsesOutput(
        { output: [messageItem("msg_a", "a")], status: "completed" },
        [{ item: messageItem("msg_b", "b"), outputIndex: 0 }],
      ),
    ).toThrow(ResponsesProtocolError)
    let conflict: unknown
    try {
      completeResponsesOutput(
        {
          output: [
            {
              call_id: "call_1",
              type: "function_call",
              name: "f",
              arguments: "{}",
            },
          ],
          status: "completed",
        },
        [
          {
            item: {
              call_id: "call_2",
              type: "function_call",
              name: "f",
              arguments: "{}",
            },
            outputIndex: 0,
          },
        ],
      )
    } catch (error) {
      conflict = error
    }
    expect(conflict).toBeInstanceOf(ResponsesProtocolError)
    expect((conflict as ResponsesProtocolError).code).toBe("output-conflict")
  })

  it("rejects unassociable done items when the terminal output is present", () => {
    expect(() =>
      completeResponsesOutput(
        { output: [messageItem("msg_a", "a")], status: "completed" },
        [{ item: messageItem("orphan", "no index"), outputIndex: null }],
      ),
    ).toThrow(ResponsesProtocolError)
  })

  it("appends unindexed items only when the terminal output is empty", () => {
    const result = completeResponsesOutput({ status: "completed" }, [
      { item: messageItem("orphan", "no index"), outputIndex: null },
    ])
    expect((result.output as unknown[]).length).toBe(1)
  })

  it("rejects a terminal output that is not an array", () => {
    let caught: unknown
    try {
      completeResponsesOutput(
        { output: "not an array", status: "completed" },
        [],
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResponsesProtocolError)
    expect((caught as ResponsesProtocolError).code).toBe("output-conflict")
  })
})

describe("upstream terminal resolution", () => {
  it("resolves completed and incomplete terminals with usage passthrough", async () => {
    const completed = await consumeResponsesUpstream({
      upstream: streamFromText(
        outputItemDone(0, messageItem("msg_0", "hi")) +
          terminalEvent("response.completed", {
            id: "resp_1",
            output: [],
            status: "completed",
            usage: { input_tokens: 3, output_tokens: 5 },
          }),
      ),
    })
    expect(completed).toMatchObject({
      kind: "completed",
      response: {
        id: "resp_1",
        output: [messageItem("msg_0", "hi")],
        status: "completed",
      },
      usage: { input_tokens: 3, output_tokens: 5 },
    })

    const incomplete = await consumeResponsesUpstream({
      upstream: streamFromText(
        terminalEvent("response.incomplete", {
          incomplete_details: { reason: "max_output_tokens" },
          output: [messageItem("msg_0", "partial")],
          status: "incomplete",
        }),
      ),
    })
    expect(incomplete).toMatchObject({
      kind: "incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageItem("msg_0", "partial")],
        status: "incomplete",
      },
    })
  })

  it("ignores deltas entirely — output items come only from done events", async () => {
    const result = await consumeResponsesUpstream({
      upstream: streamFromText(
        dataEvent({
          delta: "partial text never used",
          type: "response.output_text.delta",
        }) +
          outputItemDone(0, messageItem("msg_0", "full text")) +
          terminalEvent("response.completed", {
            output: [],
            status: "completed",
          }),
      ),
    })
    if (result.kind !== "completed")
      throw new Error(`unexpected ${result.kind}`)
    expect(result.response.output).toEqual([messageItem("msg_0", "full text")])
  })

  it("classifies quota exhaustion with a validated retry hint", async () => {
    const withSeconds = await consumeResponsesUpstream({
      upstream: streamFromText(
        dataEvent({
          error: { resets_in_seconds: 120, type: "usage_limit_reached" },
          type: "error",
        }),
      ),
    })
    expect(withSeconds).toEqual({
      failure: { kind: "quota-exceeded", retryAfterMs: 120_000 },
      kind: "failed",
    })

    const resetsAt = Math.floor(Date.now() / 1_000) + 300
    const withTimestamp = await consumeResponsesUpstream({
      upstream: streamFromText(
        dataEvent({
          error: { resets_at: resetsAt, type: "usage_limit_reached" },
          type: "error",
        }),
      ),
    })
    expect(withTimestamp).toMatchObject({
      failure: { kind: "quota-exceeded", retryAfterMs: expect.any(Number) },
      kind: "failed",
    })
    const retryAfterMs =
      withTimestamp.kind === "failed"
        ? (withTimestamp.failure.retryAfterMs ?? -1)
        : -1
    expect(retryAfterMs).toBeGreaterThan(0)
    expect(retryAfterMs).toBeLessThanOrEqual(300_000)

    // A stale or invalid reset hint yields no retry hint at all.
    for (const error of [
      {
        resets_at: Math.floor(Date.now() / 1_000) - 60,
        type: "usage_limit_reached",
      },
      { resets_in_seconds: -5, type: "usage_limit_reached" },
      { resets_in_seconds: "soon", type: "usage_limit_reached" },
    ]) {
      const result = await consumeResponsesUpstream({
        upstream: streamFromText(dataEvent({ error, type: "error" })),
      })
      expect(result).toEqual({
        failure: { kind: "quota-exceeded" },
        kind: "failed",
      })
    }
  })

  it("classifies authentication, transient, and unknown upstream failures without leaking bodies", async () => {
    for (const [payload, expected] of [
      [
        { error: { code: "invalid_api_key" }, type: "error" },
        "reauthorization-required",
      ],
      [
        { error: { code: "unauthorized" }, type: "error" },
        "reauthorization-required",
      ],
      [
        { error: { type: "authentication_error" }, type: "error" },
        "reauthorization-required",
      ],
      [
        { error: { code: "rate_limit_exceeded" }, type: "error" },
        "unavailable",
      ],
      [
        { error: { message: "model is at capacity" }, type: "error" },
        "unavailable",
      ],
      [
        {
          error: {
            code: "context_length_exceeded",
            message: "too many tokens",
          },
          type: "error",
        },
        "unavailable",
      ],
      [{ error: { code: "totally_new_code" }, type: "error" }, "unavailable"],
      [{ type: "error" }, "unavailable"],
    ] as Array<[Record<string, unknown>, string]>) {
      const result = await consumeResponsesUpstream({
        upstream: streamFromText(dataEvent(payload)),
      })
      expect(result).toEqual({
        failure: { kind: expected },
        kind: "failed",
      })
    }

    // response.failed carries its error inside response.error.
    const nested = await consumeResponsesUpstream({
      upstream: streamFromText(
        dataEvent({
          response: {
            error: { type: "usage_limit_reached", resets_in_seconds: 60 },
          },
          type: "response.failed",
        }),
      ),
    })
    expect(nested).toEqual({
      failure: { kind: "quota-exceeded", retryAfterMs: 60_000 },
      kind: "failed",
    })

    // A string error body classifies as unavailable and never surfaces.
    const stringError = await consumeResponsesUpstream({
      upstream: streamFromText(
        dataEvent({ error: "something broke", type: "error" }),
      ),
    })
    expect(stringError).toEqual({
      failure: { kind: "unavailable" },
      kind: "failed",
    })
  })

  it("treats EOF without a terminal, unparseable events, and oversized streams as protocol failures", async () => {
    const eof = await consumeResponsesUpstream({
      upstream: streamFromText(dataEvent({ type: "response.created" })),
    })
    expect(eof).toEqual({ code: "missing-terminal", kind: "protocol-failure" })

    const unparseable = await consumeResponsesUpstream({
      upstream: streamFromText("data: {not json}\n\n"),
    })
    expect(unparseable).toEqual({
      code: "unparseable-event",
      kind: "protocol-failure",
    })

    const noType = await consumeResponsesUpstream({
      upstream: streamFromText('data: {"a":1}\n\n'),
    })
    expect(noType).toEqual({
      code: "unparseable-event",
      kind: "protocol-failure",
    })

    // Cumulative reads are capped at 8 MiB.
    const bigPayload = "x".repeat(1_048_576)
    const oversize = await consumeResponsesUpstream({
      upstream: streamFromChunks(
        Array.from({ length: 9 }, (_, index) =>
          encode(
            dataEvent({
              payload: bigPayload,
              type: "response.created",
              seq: index,
            }),
          ),
        ),
      ),
    })
    expect(oversize).toEqual({
      code: "stream-oversize",
      kind: "protocol-failure",
    })
  })

  it("reports an oversize completed terminal after output completion", async () => {
    // Each done event stays below the 4 MiB single-event cap and the stream
    // below the 8 MiB cumulative cap, but completion combines them past the
    // terminal size limit.
    const bigText = "y".repeat(2_200_000)
    const bigItem = (id: string) => ({
      content: [{ text: bigText, type: "output_text" }],
      id,
      role: "assistant",
      type: "message",
    })
    const result = await consumeResponsesUpstream({
      upstream: streamFromText(
        outputItemDone(1, bigItem("msg_1")) +
          outputItemDone(2, bigItem("msg_2")) +
          terminalEvent("response.completed", {
            output: [messageItem("msg_0", "first")],
            status: "completed",
          }),
      ),
    })
    expect(result).toEqual({
      code: "terminal-oversize",
      kind: "protocol-failure",
    })
  })

  it("forwards non-terminal frames through the sink in order", async () => {
    const forwarded: string[] = []
    const result = await consumeResponsesUpstream({
      onEvent: (frame) => {
        forwarded.push(`${frame.event ?? "-"}:${frame.data}`)
      },
      upstream: streamFromText(
        dataEvent({ type: "response.created" }) +
          outputItemDone(0, messageItem("msg_0", "hi")) +
          dataEvent({ delta: "hi", type: "response.output_text.delta" }) +
          terminalEvent("response.completed", {
            output: [messageItem("msg_0", "hi")],
            status: "completed",
          }),
      ),
    })
    expect(result).toMatchObject({ kind: "completed" })
    expect(forwarded).toEqual([
      '-:{"type":"response.created"}',
      '-:{"item":{"content":[{"text":"hi","type":"output_text"}],"id":"msg_0","role":"assistant","status":"completed","type":"message"},"output_index":0,"type":"response.output_item.done"}',
      '-:{"delta":"hi","type":"response.output_text.delta"}',
    ])
  })

  it("resolves an aborted signal before any terminal", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await consumeResponsesUpstream({
      signal: controller.signal,
      upstream: streamFromText(dataEvent({ type: "response.created" })),
    })
    expect(result).toEqual({ kind: "aborted" })
  })

  it("maps failure kinds to the downstream problem slugs", () => {
    expect(responsesFailureProblemSlug("quota-exceeded")).toBe(
      "ai-upstream-quota-exceeded",
    )
    expect(responsesFailureProblemSlug("reauthorization-required")).toBe(
      "ai-reauthorization-required",
    )
    expect(responsesFailureProblemSlug("unavailable")).toBe(
      "ai-upstream-unavailable",
    )
    expect(responsesFailureProblemSlug("missing-terminal")).toBe(
      "ai-upstream-protocol-error",
    )
    expect(responsesFailureProblemSlug("stream-oversize")).toBe(
      "ai-upstream-protocol-error",
    )
  })
})

describe("downstream SSE writer", () => {
  it("writes frames in order and closes cleanly", async () => {
    const writer = new ResponsesSseWriter()
    await writer.writeEvent("response.created", '{"type":"response.created"}')
    await writer.writeEvent(null, '{"type":"response.in_progress"}')
    writer.close()
    expect(await readAll(writer.stream)).toBe(
      'event: response.created\ndata: {"type":"response.created"}\n\n' +
        'data: {"type":"response.in_progress"}\n\n',
    )
  })

  it("sends heartbeats only when due and only into an empty buffer", async () => {
    let clock = 1_000_000
    const writer = new ResponsesSseWriter({ now: () => clock })
    await writer.sendHeartbeatIfDue()
    expect(writer.bytesWritten()).toBe(0)
    clock += AI_SSE_HEARTBEAT_INTERVAL_MS - 1
    await writer.sendHeartbeatIfDue()
    expect(writer.bytesWritten()).toBe(0)
    clock += 1
    await writer.sendHeartbeatIfDue()
    expect(writer.bytesWritten()).toBe(": keepalive\n\n".length)
    // After the terminal the stream is closed and heartbeats stop.
    await writer.writeEvent("response.completed", "{}")
    writer.close()
    clock += AI_SSE_HEARTBEAT_INTERVAL_MS * 2
    await writer.sendHeartbeatIfDue()
    expect(writer.bytesWritten()).toBe(
      ": keepalive\n\n".length +
        "event: response.completed\ndata: {}\n\n".length,
    )
  })

  it("propagates backpressure instead of buffering without bound", async () => {
    const writer = new ResponsesSseWriter()
    // Enough frames to fill the bounded buffer with margin even though the
    // stream itself may buffer a chunk before backpressure kicks in.
    const frameCount = 10
    const frame = "z".repeat(16 * 1_024)
    const writes: Array<Promise<boolean>> = []
    for (let index = 0; index < frameCount; index++) {
      // The pipeline awaits each write before producing the next frame;
      // mirror that sequential invocation so the space check observes the
      // accumulated buffer, as in production.
      writes.push(writer.writeEvent(null, frame))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    // The final write stays pending: the buffer is above the high-water mark
    // and no consumer is attached yet.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const settledEarly = await Promise.race([
      writes.at(-1)!.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ])
    expect(settledEarly).toBe(false)
    // A consumer draining the stream unblocks the pending writes.
    const drained = readAll(writer.stream)
    await new Promise((resolve) => setTimeout(resolve, 50))
    writer.close()
    const text = await drained
    expect(text.length).toBe(frameCount * (frame.length + 8))
    for (const write of writes) await expect(write).resolves.toBe(true)
  })

  it("stops writing once the consumer cancels", async () => {
    const writer = new ResponsesSseWriter()
    await writer.writeEvent("response.created", "{}")
    await writer.stream.cancel()
    // Writes after cancellation are no-ops that report success.
    await expect(writer.writeEvent("response.completed", "{}")).resolves.toBe(
      true,
    )
    expect(writer.isCancelled()).toBe(true)
  })
})

describe("SSE pipeline end to end", () => {
  const upstreamSequence =
    dataEvent({ type: "response.created" }, "response.created") +
    outputItemDone(0, messageItem("msg_0", "hello")) +
    dataEvent(
      { delta: "hel", type: "response.output_text.delta" },
      "response.output_text.delta",
    ) +
    terminalEvent("response.completed", {
      id: "resp_1",
      output: [],
      status: "completed",
    })

  it("forwards events, emits the completed terminal, and closes the stream", async () => {
    const writer = new ResponsesSseWriter()
    const done = runResponsesSsePipeline({
      requestId: "req-1",
      upstream: streamFromText(upstreamSequence),
      writer,
    })
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toMatchObject({ kind: "completed" })
    expect(text).toContain(
      'event: response.created\ndata: {"type":"response.created"}',
    )
    expect(text).toContain(
      'data: {"delta":"hel","type":"response.output_text.delta"}',
    )
    const terminalFrame = "event: response.completed\ndata: "
    const terminalIndex = text.indexOf(terminalFrame)
    expect(terminalIndex).toBeGreaterThan(0)
    const terminalPayload = JSON.parse(
      text.slice(
        terminalIndex + terminalFrame.length,
        text.indexOf("\n\n", terminalIndex),
      ),
    )
    expect(terminalPayload).toMatchObject({
      id: "resp_1",
      output: [messageItem("msg_0", "hello")],
      status: "completed",
    })
    // Exactly one terminal and a clean close after it.
    expect(text.indexOf("event: response.completed", terminalIndex + 1)).toBe(
      -1,
    )
  })

  it("emits one sanitized error event for upstream failures without leaking bodies", async () => {
    const writer = new ResponsesSseWriter()
    const done = runResponsesSsePipeline({
      requestId: "req-2",
      upstream: streamFromText(
        dataEvent({ type: "response.created" }) +
          dataEvent({
            error: { message: "secret upstream detail" },
            type: "error",
          }),
      ),
      writer,
    })
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toMatchObject({
      failure: { kind: "unavailable" },
      kind: "failed",
    })
    const errorFrameIndex = text.indexOf("event: error\ndata: ")
    expect(errorFrameIndex).toBeGreaterThan(0)
    const errorPayload = JSON.parse(
      text.slice(errorFrameIndex + "event: error\ndata: ".length),
    )
    expect(errorPayload).toEqual({
      detail: "The upstream AI service is currently unavailable.",
      requestId: "req-2",
      status: 503,
      title: "AI upstream unavailable",
      type: "https://auth.eruoo.me/problems/ai-upstream-unavailable",
    })
    expect(text).not.toContain("secret upstream detail")
    expect(text.indexOf("event: error", errorFrameIndex + 1)).toBe(-1)
  })

  it("terminates with a protocol error event on EOF without a terminal", async () => {
    const writer = new ResponsesSseWriter()
    const done = runResponsesSsePipeline({
      requestId: "req-3",
      upstream: streamFromText(dataEvent({ type: "response.created" })),
      writer,
    })
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toEqual({
      code: "missing-terminal",
      kind: "protocol-failure",
    })
    expect(text).toContain(
      '"https://auth.eruoo.me/problems/ai-upstream-protocol-error"',
    )
  })

  it("sends a heartbeat while the upstream stalls and keeps the terminal after it", async () => {
    let clock = 1_000_000
    const writer = new ResponsesSseWriter({ now: () => clock })
    // Make the first heartbeat due immediately so the pipeline sends it
    // without waiting on real time; the follow-up timer would sleep for a
    // full interval, which the race cancels as soon as data arrives.
    clock += AI_SSE_HEARTBEAT_INTERVAL_MS
    let releaseUpstream: (() => void) | undefined
    const stalled = new Promise<void>((resolve) => {
      releaseUpstream = resolve
    })
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await stalled
        controller.enqueue(
          encode(
            terminalEvent("response.completed", {
              output: [],
              status: "completed",
            }),
          ),
        )
        controller.close()
      },
    })
    const done = runResponsesSsePipeline({
      requestId: "req-4",
      upstream,
      writer,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    releaseUpstream?.()
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toMatchObject({ kind: "completed" })
    expect(text.startsWith(": keepalive\n\n")).toBe(true)
    expect(text).toContain("event: response.completed")
  })

  it("stops cleanly when the consumer cancels mid-stream", async () => {
    const writer = new ResponsesSseWriter()
    let releaseUpstream: (() => void) | undefined
    const stalled = new Promise<void>((resolve) => {
      releaseUpstream = resolve
    })
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(encode(dataEvent({ type: "response.created" })))
        await stalled
        controller.enqueue(
          encode(
            terminalEvent("response.completed", {
              output: [],
              status: "completed",
            }),
          ),
        )
        controller.close()
      },
    })
    const done = runResponsesSsePipeline({
      requestId: "req-5",
      upstream,
      writer,
    })
    const reader = writer.stream.getReader()
    await reader.read()
    await reader.cancel()
    releaseUpstream?.()
    const result = await done
    expect(writer.isCancelled()).toBe(true)
    // The true terminal still resolves for the invocation record.
    expect(result).toMatchObject({ kind: "completed" })
  })

  it("fails the stream when the downstream transfer budget is exhausted", async () => {
    const writer = new ResponsesSseWriter()
    const bigDelta = "d".repeat(1024 * 1_024)
    // ~9 MiB of forwarded delta events exceeds the 8 MiB transfer budget.
    const chunks: Uint8Array[] = Array.from({ length: 9 }, () =>
      encode(
        dataEvent({ delta: bigDelta, type: "response.output_text.delta" }),
      ),
    )
    chunks.push(
      encode(
        terminalEvent("response.completed", {
          output: [],
          status: "completed",
        }),
      ),
    )
    const done = runResponsesSsePipeline({
      requestId: "req-6",
      upstream: streamFromChunks(chunks),
      writer,
    })
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toEqual({
      code: "stream-oversize",
      kind: "protocol-failure",
    })
    // The single terminal error event is still delivered.
    expect(text).toContain("event: error")
    expect(text).not.toContain("response.completed")
  })

  it("counts a line split across chunks once, so a near-cap event still parses", () => {
    // 3 MiB single-line event: comfortably under the 4 MiB cap, but large
    // enough that double-counting any fragment would blow past it.
    const payload = "a".repeat(3 * 1_024 * 1_024)
    const frame = `data: {"delta":"${payload}","type":"response.output_text.delta"}\n\n`
    const bytes = encode(frame)
    const parser = new UpstreamSseParser()
    const events: Array<{ data: string; event: string | null }> = []
    // Eight equal chunks: every data line is split mid-line at chunk edges.
    const chunkSize = Math.ceil(bytes.byteLength / 8)
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      events.push(...parser.push(bytes.slice(offset, offset + chunkSize)))
    }
    expect(events).toEqual([
      {
        data: `{"delta":"${payload}","type":"response.output_text.delta"}`,
        event: null,
      },
    ])
  })

  it("does not busy-spin when a due heartbeat is skipped under backpressure", async () => {
    let clock = 1_000_000
    const writer = new ResponsesSseWriter({
      heartbeatIntervalMs: 50,
      now: () => clock,
    })
    // The upstream stalls before its terminal; the consumer reads one chunk
    // and then stalls too, so a heartbeat comes due while the writer buffer
    // still holds a frame — the interaction that must wait, never spin.
    let releaseTerminal: (() => void) | undefined
    const terminalGated = new Promise<void>((resolve) => {
      releaseTerminal = resolve
    })
    let deliveredOpening = false
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!deliveredOpening) {
          deliveredOpening = true
          controller.enqueue(encode(dataEvent({ type: "response.created" })))
          controller.enqueue(
            encode(
              dataEvent({ delta: "x", type: "response.output_text.delta" }),
            ),
          )
          return
        }
        await terminalGated
        controller.enqueue(
          encode(
            terminalEvent("response.completed", {
              output: [],
              status: "completed",
            }),
          ),
        )
        controller.close()
      },
    })
    const done = runResponsesSsePipeline({
      requestId: "req-8",
      upstream,
      writer,
    })
    const reader = writer.stream.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    // Let a heartbeat come due while the consumer is stalled. A busy-spin
    // starves timers, so this timeout firing at all is the assertion; the
    // pipeline meanwhile waits for the buffer to drain.
    await new Promise((resolve) => setTimeout(resolve, 120))
    clock += 50
    await new Promise((resolve) => setTimeout(resolve, 120))
    // Resuming the consumer drains the buffer; the waiting heartbeat sends,
    // the gated terminal is read, and the pipeline completes.
    releaseTerminal?.()
    let rest = ""
    while (true) {
      const { done: chunkDone, value } = await reader.read()
      if (chunkDone) break
      rest += new TextDecoder().decode(value, { stream: true })
    }
    const result = await done
    expect(result).toMatchObject({ kind: "completed" })
    expect(rest).toContain(": keepalive")
    expect(rest).toContain("event: response.completed")
  })

  it("still delivers the terminal error event when the budget is nearly exhausted", async () => {
    const writer = new ResponsesSseWriter()
    // Fill the transfer budget to within less than the terminal error
    // frame's length, so the strict path alone would refuse the frame. The
    // writer frames events as `data: ${json}\n\n`, so sizes are computed
    // with the exact same format.
    const frameOf = (event: Record<string, unknown>) =>
      encode(`data: ${JSON.stringify(event)}\n\n`)
    const bigFrame = frameOf({
      delta: "f".repeat(64 * 1_024),
      type: "response.output_text.delta",
    })
    const tailFrame = frameOf({
      delta: "t",
      type: "response.output_text.delta",
    })
    const chunks: Uint8Array[] = []
    let written = 0
    while (AI_STREAM_BUDGET - written >= bigFrame.byteLength) {
      chunks.push(bigFrame)
      written += bigFrame.byteLength
    }
    while (AI_STREAM_BUDGET - written >= 170) {
      chunks.push(tailFrame)
      written += tailFrame.byteLength
    }
    // The remaining headroom is smaller than the error frame, yet never
    // negative — every filler frame was admitted by the budget.
    expect(AI_STREAM_BUDGET - written).toBeLessThan(170)
    expect(written).toBeLessThanOrEqual(AI_STREAM_BUDGET)
    chunks.push(
      encode(
        dataEvent({ error: { type: "usage_limit_reached" }, type: "error" }),
      ),
    )
    const done = runResponsesSsePipeline({
      requestId: "req-9",
      upstream: streamFromChunks(chunks),
      writer,
    })
    const text = await readAll(writer.stream)
    const result = await done
    expect(result).toMatchObject({
      failure: { kind: "quota-exceeded" },
      kind: "failed",
    })
    // The bounded overrun delivers the single terminal error event.
    expect(text).toContain("event: error")
    expect(text).toContain("ai-upstream-quota-exceeded")
    // The budget overshoot stays bounded by the small error frame.
    const errorFrameLength = "event: error\ndata: ".length + 260
    expect(writer.bytesWritten()).toBeLessThanOrEqual(
      AI_STREAM_BUDGET + errorFrameLength,
    )
  })

  it("yields an equivalent terminal in JSON and SSE modes for the same events", async () => {
    const jsonResult: ResponsesTerminalResult = await consumeResponsesUpstream({
      upstream: streamFromText(upstreamSequence),
    })
    const writer = new ResponsesSseWriter()
    const done = runResponsesSsePipeline({
      requestId: "req-7",
      upstream: streamFromText(upstreamSequence),
      writer,
    })
    const text = await readAll(writer.stream)
    await done
    if (jsonResult.kind !== "completed")
      throw new Error("json mode did not complete")
    const terminalFrame = "event: response.completed\ndata: "
    const terminalIndex = text.indexOf(terminalFrame)
    const ssePayload = JSON.parse(
      text.slice(
        terminalIndex + terminalFrame.length,
        text.indexOf("\n\n", terminalIndex),
      ),
    )
    expect(ssePayload).toEqual(jsonResult.response)
  })
})

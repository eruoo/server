import { z } from "zod"

/** Strict DeepSeek Responses subset. Unsupported semantics fail locally with 422. */
function base64DataUrlImage(value: string): boolean {
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]*)$/.exec(value)
  if (match === null || match[2].length === 0) return false
  try {
    // Well-formed base64 only; the decoded content itself is uninterpreted.
    atob(match[2])
    return true
  } catch {
    return false
  }
}

const dataUrlImage = z
  .string()
  .refine(base64DataUrlImage, {
    error: "input_image must be an inline base64 PNG, JPEG, or WebP data URL",
  })
  .meta({ description: "Inline base64 PNG, JPEG, or WebP image data URL." })

const inputTextContent = z
  .object({
    text: z.string().meta({ description: "The text content." }),
    type: z.literal("input_text"),
  })
  .strict()

const outputTextContent = z
  .object({
    text: z.string().meta({ description: "The text content." }),
    type: z.literal("output_text"),
  })
  .strict()

const inputImageContent = z
  .object({
    image_url: dataUrlImage,
    type: z.literal("input_image"),
  })
  .strict()

const messageContentPart = z.discriminatedUnion("type", [
  inputTextContent,
  inputImageContent,
  outputTextContent,
])

const messageInputItem = z
  .object({
    content: z
      .array(messageContentPart)
      .min(1)
      .meta({ description: "Message content parts." }),
    role: z.enum(["system", "user", "assistant"]).meta({
      description: "The conversation role of this message.",
    }),
    type: z.literal("message"),
  })
  .strict()

const functionCallInputItem = z
  .object({
    arguments: z
      .string()
      .meta({ description: "The serialized function call arguments." }),
    call_id: z
      .string()
      .min(1)
      .meta({ description: "The call identifier this item belongs to." }),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .meta({ description: "The function name." }),
    type: z.literal("function_call"),
  })
  .strict()

const functionCallOutputInputItem = z
  .object({
    call_id: z
      .string()
      .min(1)
      .meta({ description: "The call identifier this output answers." }),
    output: z
      .string()
      .meta({ description: "The serialized function call output." }),
    type: z.literal("function_call_output"),
  })
  .strict()

const reasoningInputItem = z
  .object({
    id: z.string().optional(),
    type: z.literal("reasoning"),
    content: z
      .array(
        z
          .object({ type: z.literal("reasoning_text"), text: z.string() })
          .strict(),
      )
      .min(1),
  })
  .strict()

const inputItem = z.discriminatedUnion("type", [
  messageInputItem,
  functionCallInputItem,
  functionCallOutputInputItem,
  reasoningInputItem,
])

const inputSchema = z.union([
  z.string().meta({ description: "A single text prompt." }),
  z.array(inputItem).min(1).meta({ description: "Multi-turn input items." }),
])

const reasoningSchema = z
  .object({ effort: z.enum(["none", "low", "high", "max"]) })
  .strict()

const textFormatSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .meta({ description: "The structured output schema name." }),
    schema: z
      .record(z.string(), z.unknown())
      .meta({ description: "The JSON schema object." }),
    type: z.literal("json_schema"),
  })
  .strict()

const textSchema = z
  .object({
    format: textFormatSchema.meta({
      description: "The structured output format.",
    }),
  })
  .strict()

const functionTool = z
  .object({
    description: z
      .string()
      .optional()
      .meta({ description: "The function description." }),
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .meta({ description: "The function name." }),
    parameters: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: "The JSON schema for the parameters." }),
    type: z.literal("function"),
  })
  .strict()

const toolChoiceSchema = z.union([
  z
    .literal("auto")
    .meta({ description: "The model decides whether to call tools." }),
  z.literal("required"),
  z.literal("none").meta({ description: "Tools are not called." }),
  z
    .object({
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .meta({ description: "The function to force." }),
      type: z.literal("function"),
    })
    .strict()
    .meta({ description: "Force one specific function." }),
])

const responsesRequestBodySchema = z
  .object({
    input: inputSchema.meta({
      description: "The prompt or multi-turn input items.",
    }),
    instructions: z
      .string()
      .optional()
      .meta({ description: "System instructions." }),
    max_output_tokens: z.number().int().positive().max(393216).optional(),
    model: z.string().min(1).meta({
      description:
        "The external model identifier (connection slug / model id).",
    }),
    parallel_tool_calls: z
      .literal(true)
      .optional()
      .meta({ description: "Whether tools may run in parallel." }),
    reasoning: reasoningSchema
      .optional()
      .meta({ description: "Reasoning parameters." }),
    store: z
      .literal(false)
      .meta({ description: "Only store=false is supported." })
      .optional(),
    stream: z
      .boolean()
      .meta({ description: "Whether to stream; defaults to true." })
      .optional(),
    text: textSchema
      .optional()
      .meta({ description: "Structured output settings." }),
    tool_choice: toolChoiceSchema
      .optional()
      .meta({ description: "Tool selection policy." }),
    tools: z
      .array(functionTool)
      .optional()
      .meta({ description: "Function tool definitions." }),
  })
  .strict()

export type ResponsesRequestBody = z.infer<typeof responsesRequestBodySchema>

export type ResponsesRequestValidation =
  | { ok: true; value: ResponsesRequestBody }
  | { ok: false; issues: Array<{ path: string; message: string }> }

/**
 * Validates one request body against the strict subset. Unknown top-level
 * fields surface as a single zod root issue that names every unrecognized
 * key together; a known field with an invalid value surfaces with its own
 * precise path. Nothing is silently removed.
 */
export function validateResponsesRequest(
  body: unknown,
): ResponsesRequestValidation {
  const parsed = responsesRequestBodySchema.safeParse(body)
  if (parsed.success) {
    const request = parsed.data
    const reject = (
      path: string,
      message: string,
    ): ResponsesRequestValidation => ({
      ok: false,
      issues: [{ path, message }],
    })
    const names = (request.tools ?? []).map((tool) => tool.name)
    if (new Set(names).size !== names.length)
      return reject("tools", "Function names must be unique")
    if (
      typeof request.tool_choice === "object" &&
      !names.includes(request.tool_choice.name)
    )
      return reject("tool_choice", "The selected function must be declared")
    if (request.tool_choice === "required" && names.length === 0)
      return reject("tool_choice", "Required tools must be declared")
    if (Array.isArray(request.input)) {
      const calls = new Set<string>(),
        outputs = new Set<string>()
      for (const item of request.input) {
        if (
          item.type === "message" &&
          item.role !== "user" &&
          item.content.some((part) => part.type === "input_image")
        )
          return reject("input", "Images are supported in user messages only")
        if (item.type === "function_call") {
          if (calls.has(item.call_id))
            return reject("input", "Duplicate function call id")
          calls.add(item.call_id)
        }
        if (item.type === "function_call_output") {
          if (outputs.has(item.call_id) || !calls.has(item.call_id))
            return reject("input", "Function output must follow its call")
          outputs.add(item.call_id)
        }
      }
      if (calls.size !== outputs.size)
        return reject("input", "Every function call must have an output")
    }
    return { ok: true, value: request }
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.map((segment) => String(segment)).join(".") || "(root)",
    })),
  }
}

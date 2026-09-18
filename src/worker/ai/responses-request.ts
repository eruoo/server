import { z } from "zod"

/**
 * Strict request subset for the Responses-style AI invocation contract.
 *
 * docs/specs/ai-service.md §6.2 defines exactly which fields this service
 * accepts. Every unknown or unsupported field — including the SDK defaults
 * `temperature`, `max_output_tokens`, and `metadata`, which the Codex
 * reference removed or never supported — is rejected with a validation
 * failure instead of being silently dropped. Model-level capability checks
 * (reasoning efforts, structured output availability) are the caller's
 * responsibility in the invocation chain; this module only validates the
 * wire shape.
 *
 * The schemas stay composable so the route layer can reuse them for the
 * generated OpenAPI contract.
 */

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
    role: z.enum(["system", "developer", "user", "assistant"]).meta({
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
    name: z.string().min(1).meta({ description: "The function name." }),
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

const reasoningSummaryText = z
  .object({
    text: z.string().meta({ description: "The summary text." }),
    type: z.literal("summary_text"),
  })
  .strict()

const reasoningInputItem = z
  .object({
    encrypted_content: z.string().optional().meta({
      description: "Opaque reasoning state returned by a previous response.",
    }),
    id: z
      .string()
      .optional()
      .meta({ description: "The reasoning item identifier." }),
    summary: z
      .array(reasoningSummaryText)
      .optional()
      .meta({ description: "Reasoning summaries." }),
    type: z.literal("reasoning"),
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
  .object({
    effort: z
      .string()
      .min(1)
      .meta({ description: "Reasoning effort declared by the model catalog." }),
  })
  .strict()

const textFormatSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .meta({ description: "The structured output schema name." }),
    schema: z.unknown().meta({ description: "The JSON schema object." }),
    strict: z
      .boolean()
      .optional()
      .meta({ description: "Whether strict schema mode is enabled." }),
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
    name: z.string().min(1).meta({ description: "The function name." }),
    parameters: z
      .unknown()
      .optional()
      .meta({ description: "The JSON schema for the parameters." }),
    strict: z
      .boolean()
      .optional()
      .meta({ description: "Whether strict schema mode is enabled." }),
    type: z.literal("function"),
  })
  .strict()

const toolChoiceSchema = z.union([
  z
    .literal("auto")
    .meta({ description: "The model decides whether to call tools." }),
  z.literal("none").meta({ description: "Tools are not called." }),
  z
    .object({
      name: z.string().min(1).meta({ description: "The function to force." }),
      type: z.literal("function"),
    })
    .strict()
    .meta({ description: "Force one specific function." }),
])

export const responsesRequestBodySchema = z
  .object({
    include: z
      .array(z.literal("reasoning.encrypted_content"))
      .meta({
        description:
          "Only reasoning.encrypted_content is supported, for carrying opaque multi-turn state.",
      })
      .optional(),
    input: inputSchema.meta({
      description: "The prompt or multi-turn input items.",
    }),
    instructions: z
      .string()
      .optional()
      .meta({ description: "System instructions." }),
    model: z.string().min(1).meta({
      description:
        "The external model identifier (connection slug / model id).",
    }),
    parallel_tool_calls: z
      .boolean()
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
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.map((segment) => String(segment)).join(".") || "(root)",
    })),
  }
}

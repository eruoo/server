import type { ProblemSlug } from "../http/problem-registry"

export const DEEPSEEK_PROVIDER_TYPE = "deepseek"
const DEEPSEEK_ORIGIN = "https://api.deepseek.com"
export const DEEPSEEK_DEFAULT_EFFORT = "max"
export const DEEPSEEK_REASONING_EFFORTS = [
  "none",
  "low",
  "high",
  "max",
] as const

export function getDeepSeekProviderDefinition() {
  return {
    authorizationKind: "api-key",
    providerType: DEEPSEEK_PROVIDER_TYPE,
    responsesStyle: "responses-subset",
    defaultReasoningEffort: DEEPSEEK_DEFAULT_EFFORT,
  }
}

export function buildDeepSeekResponsesRequest(input: {
  apiKey: string
  stream: boolean
}) {
  return {
    url: `${DEEPSEEK_ORIGIN}/responses`,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      accept: input.stream ? "text/event-stream" : "application/json",
    },
  }
}

export function deepSeekHttpProblem(status: number): ProblemSlug {
  if (status === 401) return "ai-reauthorization-required"
  if (status === 402) return "ai-upstream-quota-exceeded"
  if (status === 429) return "ai-upstream-rate-limited"
  if (status === 403 || status >= 500) return "ai-upstream-unavailable"
  return "ai-upstream-protocol-error"
}

/** Capability facts from the official pricing and Responses pages, checked 2026-09-22.
 * /models reports identifiers, not capabilities. Unknown identifiers remain closed.
 * Model versions are deliberately not inferred from aliases returned by the API.
 */
export function deepSeekModelCapabilities(id: string) {
  const supported = id === "deepseek-flash" || id === "deepseek-v4-pro"
  return {
    supportedInApi: supported,
    reasoningEfforts: supported ? [...DEEPSEEK_REASONING_EFFORTS] : [],
    vision: id === "deepseek-flash",
    structuredOutput: supported,
    functionTools: supported,
    maxOutputTokens: supported,
    defaultReasoningEffort: supported ? DEEPSEEK_DEFAULT_EFFORT : null,
  }
}

export async function listDeepSeekModels(
  apiKey: string,
  options: { signal: AbortSignal },
): Promise<
  | {
      ok: true
      models: {
        upstreamModelId: string
        displayName: null
        capabilities: string
      }[]
    }
  | { ok: false; problem: ProblemSlug; status?: number }
> {
  let response: Response
  try {
    response = await fetch(`${DEEPSEEK_ORIGIN}/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
      signal: options.signal,
      redirect: "manual",
    })
  } catch {
    return { ok: false, problem: "ai-upstream-unavailable" }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return {
      ok: false,
      problem: deepSeekHttpProblem(response.status),
      status: response.status,
    }
  }
  const reader = response.body?.getReader()
  if (!reader) return { ok: false, problem: "ai-upstream-protocol-error" }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    let bytes = 0,
      raw = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 262144) throw new Error("Catalog exceeds limit")
      raw += decoder.decode(value, { stream: true })
    }
    raw += decoder.decode()
    const body = JSON.parse(raw) as { data?: unknown }
    if (!Array.isArray(body.data) || body.data.length > 200)
      throw new Error("Invalid catalog")
    const seen = new Set<string>()
    const models = body.data.map((entry: unknown) => {
      if (entry === null || typeof entry !== "object")
        throw new Error("Invalid model")
      const id = (entry as { id?: unknown }).id
      if (
        typeof id !== "string" ||
        id.length === 0 ||
        id.length > 200 ||
        seen.has(id)
      )
        throw new Error("Invalid model id")
      seen.add(id)
      return {
        upstreamModelId: id,
        displayName: null,
        capabilities: JSON.stringify(deepSeekModelCapabilities(id)),
      }
    })
    return { ok: true, models }
  } catch {
    return {
      ok: false,
      problem: options.signal.aborted
        ? "ai-upstream-unavailable"
        : "ai-upstream-protocol-error",
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

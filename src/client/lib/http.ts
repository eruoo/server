export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message)
  }
}

export interface DeadlineFetchInit extends RequestInit {
  /**
   * Overrides the method-derived budget. AI management operations that reach
   * the upstream run on their own stage budget (design §6.1: 35 s in the SPA),
   * so they cannot use the generic 30 s mutation budget.
   */
  deadlineMs?: number
}

export async function deadlineFetch(
  input: RequestInfo | URL,
  init?: DeadlineFetchInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error("请求超时，请重试")),
    init?.deadlineMs ??
      (["POST", "PUT", "PATCH", "DELETE"].includes(
        (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase(),
      )
        ? 30_000
        : 10_000),
  )
  const signals = [
    controller.signal,
    init?.signal,
    input instanceof Request ? input.signal : undefined,
  ].filter((signal): signal is AbortSignal => !!signal)
  try {
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.any(signals),
      credentials: "same-origin",
    })
    if (!response.body) return response
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1_048_576) {
        await reader.cancel()
        throw new Error("响应超过大小限制")
      }
      chunks.push(value)
    }
    const body = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function requestJson<T>(
  path: string,
  init?: DeadlineFetchInit,
): Promise<T> {
  const response = await deadlineFetch(path, init)
  const body = await response.json()
  if (!response.ok)
    throw new ApiError(
      response.status,
      body.type ?? "",
      body.detail ?? body.message ?? "请求未完成，请重试",
    )
  return body as T
}

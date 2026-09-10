import { z } from "@hono/zod-openapi"
import type { TypedResponse } from "hono"

import {
  problemTypeRegistry,
  problemTypeUri,
  type ProblemSlug,
} from "./problem-registry"

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int(),
    detail: z.string(),
    requestId: z.string(),
  })
  .openapi("Problem")
export const errorResponse = {
  description: "Request rejected or dependency unavailable",
  content: { "application/problem+json": { schema: problemSchema } },
}
type ProblemBody = z.infer<typeof problemSchema>
type ProblemStatus = (typeof problemTypeRegistry)[ProblemSlug]["status"]
type ProblemResponse = Response &
  TypedResponse<ProblemBody, ProblemStatus, "json">

export function problem(slug: ProblemSlug, requestId: string): ProblemResponse {
  const definition = problemTypeRegistry[slug]
  return Response.json(
    {
      type: problemTypeUri(slug),
      title: definition.title,
      status: definition.status,
      detail: definition.description,
      requestId,
    },
    {
      status: definition.status,
      headers: {
        "content-type": "application/problem+json",
        "cache-control": "no-store",
      },
    },
  ) as ProblemResponse
}

// Late work never mutates the separate response returned on timeout.
export async function withReadDeadline<T extends Response>(
  work: Promise<T>,
  requestId: string,
  timeoutMs = 5_000,
): Promise<T | ProblemResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<ProblemResponse>((resolve) => {
        timer = setTimeout(
          () => resolve(problem("request-timeout", requestId)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function boundedRequest(
  request: Request,
  maximum = 1_048_576,
): Promise<Request | null> {
  if (!request.body) return request
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new Request(request, { method: request.method, body })
}

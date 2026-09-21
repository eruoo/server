import type { ContentfulStatusCode } from "hono/utils/http-status"

interface ProblemTypeDefinition {
  description: string
  status: ContentfulStatusCode
  title: string
}

export const problemTypeRegistry = {
  "ai-concurrency-exceeded": {
    description:
      "The AI service or this API key already holds its maximum in-flight invocations; retry after checking current usage.",
    status: 429,
    title: "AI concurrency exceeded",
  },
  "ai-credential-busy": {
    description:
      "Another request is currently refreshing the upstream credential for this connection; retry after the indicated delay.",
    status: 503,
    title: "AI credential busy",
  },
  "ai-reauthorization-required": {
    description:
      "The upstream authorization for this connection is no longer usable; the owner must reauthorize before further AI calls.",
    status: 503,
    title: "AI reauthorization required",
  },
  "ai-upstream-protocol-error": {
    description:
      "The upstream response violated the supported AI protocol and cannot be completed.",
    status: 502,
    title: "AI upstream protocol error",
  },
  "ai-upstream-quota-exceeded": {
    description:
      "The upstream account's usage limit is exhausted; retry after the indicated delay.",
    status: 429,
    title: "AI upstream quota exceeded",
  },
  "ai-upstream-unavailable": {
    description: "The upstream AI service is currently unavailable.",
    status: 503,
    title: "AI upstream unavailable",
  },
  "api-key-expiration-required": {
    description:
      "An API key expiration is missing, permanent, or exceeds the permitted lifetime.",
    status: 422,
    title: "API key expiration required",
  },
  "authentication-required": {
    description:
      "The request does not provide the credential required by the operation.",
    status: 401,
    title: "Authentication required",
  },
  "insufficient-permission": {
    description:
      "The API key does not grant a permission required by the operation.",
    status: 403,
    title: "Insufficient permission",
  },
  "internal-error": {
    description: "The service encountered an unclassified internal error.",
    status: 500,
    title: "Internal server error",
  },
  "invalid-credential": {
    description: "The supplied credential is invalid, expired, or revoked.",
    status: 401,
    title: "Invalid credential",
  },
  "invalid-request": {
    description:
      "The request syntax is invalid, a credential carrier is malformed, or multiple credential carriers make the request ambiguous.",
    status: 400,
    title: "Invalid request",
  },
  "not-found": {
    description: "The requested API operation or resource does not exist.",
    status: 404,
    title: "Not found",
  },
  "payload-too-large": {
    description: "The request body exceeds the limit for the operation.",
    status: 413,
    title: "Payload too large",
  },
  "permission-denied": {
    description:
      "The authenticated principal is not allowed to access the requested resource or operation.",
    status: 403,
    title: "Permission denied",
  },
  "rate-limit-exceeded": {
    description: "A trusted rate limiter rejected the request.",
    status: 429,
    title: "Too many requests",
  },
  "recent-authentication-required": {
    description:
      "The sensitive operation requires owner authentication within the preceding 15 minutes.",
    status: 403,
    title: "Recent authentication required",
  },
  "request-timeout": {
    description: "The request exceeded the service time limit.",
    status: 504,
    title: "Request timeout",
  },
  "service-unavailable": {
    description:
      "An identity, database, or other required dependency is unavailable.",
    status: 503,
    title: "Service unavailable",
  },
  "unsupported-media-type": {
    description: "The request is missing or uses an unsupported media type.",
    status: 415,
    title: "Unsupported media type",
  },
  "validation-failed": {
    description:
      "The request is syntactically valid but does not satisfy the operation schema or input constraints.",
    status: 422,
    title: "Request validation failed",
  },
} as const satisfies Record<string, ProblemTypeDefinition>

export type ProblemSlug = keyof typeof problemTypeRegistry

export function isProblemSlug(value: string): value is ProblemSlug {
  return Object.hasOwn(problemTypeRegistry, value)
}

export function problemTypeUri(
  slug: ProblemSlug,
): `https://auth.eruoo.me/problems/${ProblemSlug}` {
  return `https://auth.eruoo.me/problems/${slug}`
}

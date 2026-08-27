import type { ContentfulStatusCode } from "hono/utils/http-status"

interface ProblemTypeDefinition {
  description: string
  status: ContentfulStatusCode
  title: string
}

export const problemTypeRegistry = {
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
  conflict: {
    description:
      "The request conflicts with the current state of the resource.",
    status: 409,
    title: "Conflict",
  },
  "insufficient-permission": {
    description:
      "The API key does not grant a permission required by the operation.",
    status: 403,
    title: "Insufficient permission",
  },
  "insufficient-scope": {
    description:
      "The OAuth access token does not grant a scope required by the operation.",
    status: 403,
    title: "Insufficient scope",
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

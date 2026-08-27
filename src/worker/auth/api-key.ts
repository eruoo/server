import type { MiddlewareHandler } from "hono"
import { z } from "zod"

import {
  API_KEY_EXPIRATION_HEADER,
  API_KEY_EXPIRATION_WARNING_WINDOW_MS,
  API_KEY_STATUS_PERMISSION,
} from "../../shared/api-key"
import type { Principal } from "../../shared/principal"
import { scheduleAuditEvent } from "../audit"
import { type ApiKeyVerifier, getInitializedApiKeyVerifier } from "../auth"
import { problem } from "../http/problem"
import type { AppBindings } from "../http/types"
import {
  hasUnsupportedBodyAccessToken,
  inspectCredentialCarriers,
} from "./carriers"
import { requireOwnerSession } from "./session"

type NonEmptyPermissions = readonly [string, ...string[]]

const verificationKeySchema = z.object({
  configId: z.literal("default"),
  expiresAt: z.date(),
  id: z.string().min(1),
  permissions: z
    .record(z.string().min(1), z.array(z.string().min(1)))
    .nullable(),
  referenceId: z.string().min(1),
})

const authenticationErrorCodes = new Set([
  "INVALID_API_KEY",
  "KEY_DISABLED",
  "KEY_EXPIRED",
  "KEY_NOT_FOUND",
])
const rateLimitErrorCodes = new Set(["RATE_LIMITED", "USAGE_EXCEEDED"])

function flattenPermissions(
  statements: Record<string, string[]> | null,
): string[] {
  const permissions = new Set<string>()

  for (const [resource, actions] of Object.entries(statements ?? {})) {
    for (const action of actions) {
      permissions.add(`${resource}:${action}`)
    }
  }

  return [...permissions].sort()
}

const requireStatusApiKeyPrincipal = createRequireApiKeyPrincipal([
  API_KEY_STATUS_PERMISSION,
])

export const requireOwnerSessionOrStatusApiKey: MiddlewareHandler<
  AppBindings
> = async (context, next) => {
  const inspection = inspectCredentialCarriers(context.req.raw)

  if (
    !inspection.invalid &&
    inspection.carriers.length === 1 &&
    inspection.carriers[0] === "apiKey"
  ) {
    return requireStatusApiKeyPrincipal(context, next)
  }

  return requireOwnerSession(context, next)
}

function scheduleRejection(
  context: Parameters<MiddlewareHandler<AppBindings>>[0],
  reason: string,
  principal?: Principal,
): void {
  scheduleAuditEvent(context, {
    ...(principal?.credentialId
      ? { credentialId: principal.credentialId }
      : {}),
    metadata: { reason },
    outcome: "failure",
    ...(principal ? { subjectId: principal.subject } : {}),
    type: reason === "expired" ? "api_key_expired" : "api_key_rejected",
  })
}

export function createRequireApiKeyPrincipal(
  requiredPermissions: NonEmptyPermissions,
): MiddlewareHandler<AppBindings> {
  if (requiredPermissions.length === 0) {
    throw new TypeError("API key routes must require at least one permission.")
  }

  const requiredPermissionSet = new Set(requiredPermissions)

  return async (context, next) => {
    const inspection = inspectCredentialCarriers(context.req.raw)
    const bodyAccessToken = await hasUnsupportedBodyAccessToken(context.req.raw)

    if (inspection.invalid || bodyAccessToken) {
      if (inspection.carriers.includes("apiKey")) {
        scheduleRejection(context, "invalid_carrier")
      }

      return problem(context, {
        detail:
          "The request contains an invalid or ambiguous credential carrier.",
        slug: "invalid-request",
      })
    }

    if (
      inspection.carriers.length !== 1 ||
      inspection.carriers[0] !== "apiKey"
    ) {
      return problem(context, {
        detail: "A valid API key is required.",
        slug: "authentication-required",
      })
    }

    const rawApiKey = context.req.header("x-api-key")
    if (!rawApiKey) {
      scheduleRejection(context, "invalid_carrier")
      return problem(context, {
        detail: "A valid API key is required.",
        slug: "authentication-required",
      })
    }

    let verification: Awaited<ReturnType<ApiKeyVerifier["api"]["verifyApiKey"]>>

    try {
      const verifier = await getInitializedApiKeyVerifier(context.env)
      verification = await verifier.api.verifyApiKey({
        body: {
          configId: "default",
          key: rawApiKey,
        },
      })
    } catch (error) {
      console.error({
        event: "api_key_dependency_failed",
        error: error instanceof Error ? error.name : "unknown_error",
        requestId: context.get("requestId"),
      })
      scheduleRejection(context, "dependency_unavailable")

      return problem(context, {
        detail: "The API key could not be verified.",
        slug: "service-unavailable",
      })
    }

    if (!verification.valid) {
      const errorCode = verification.error?.code ?? "UNKNOWN"

      if (rateLimitErrorCodes.has(errorCode)) {
        scheduleRejection(context, "rate_limited")
        return problem(context, {
          detail: "The API key request limit has been exceeded.",
          slug: "rate-limit-exceeded",
        })
      }

      if (authenticationErrorCodes.has(errorCode)) {
        scheduleRejection(
          context,
          errorCode === "KEY_EXPIRED" ? "expired" : "invalid_credential",
        )
        return problem(context, {
          detail: "A valid API key is required.",
          slug: "invalid-credential",
        })
      }

      console.error({
        event: "api_key_verification_failed",
        error: errorCode,
        requestId: context.get("requestId"),
      })
      scheduleRejection(context, "verification_failed")
      return problem(context, {
        detail: "The API key could not be verified.",
        slug: "service-unavailable",
      })
    }

    const parsedKey = verificationKeySchema.safeParse(verification.key)
    if (!parsedKey.success) {
      console.error({
        event: "api_key_data_invalid",
        requestId: context.get("requestId"),
      })
      scheduleRejection(context, "invalid_stored_data")
      return problem(context, {
        detail: "The API key could not be verified.",
        slug: "service-unavailable",
      })
    }

    const principal: Principal = {
      authMethod: "apiKey",
      credentialId: parsedKey.data.id,
      permissions: flattenPermissions(parsedKey.data.permissions),
      scopes: [],
      subject: parsedKey.data.referenceId,
    }
    const grantedPermissions = new Set(principal.permissions)

    if (
      [...requiredPermissionSet].some(
        (permission) => !grantedPermissions.has(permission),
      )
    ) {
      scheduleRejection(context, "insufficient_permission", principal)
      return problem(context, {
        detail: "The API key does not grant the required permission.",
        slug: "insufficient-permission",
      })
    }

    context.set("principal", principal)
    const expiresAt = parsedKey.data.expiresAt
    const remainingLifetimeMs = expiresAt.getTime() - Date.now()

    if (remainingLifetimeMs <= 0) {
      scheduleRejection(context, "expired", principal)
      return problem(context, {
        detail: "A valid API key is required.",
        slug: "invalid-credential",
      })
    }

    const shouldExposeExpiration =
      remainingLifetimeMs <= API_KEY_EXPIRATION_WARNING_WINDOW_MS

    await next()

    if (
      shouldExposeExpiration &&
      context.res.status >= 200 &&
      context.res.status < 300
    ) {
      context.header(API_KEY_EXPIRATION_HEADER, expiresAt.toISOString())
    }
  }
}

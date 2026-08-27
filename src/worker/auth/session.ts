import type { MiddlewareHandler } from "hono"

import type { Principal } from "../../shared/principal"
import { scheduleAuditEvent } from "../audit"
import { getInitializedAuth } from "../auth"
import { getRuntimeConfig } from "../config"
import { problem } from "../http/problem"
import type { AppBindings } from "../http/types"
import {
  hasUnsupportedBodyAccessToken,
  inspectCredentialCarriers,
} from "./carriers"

const recentAuthenticationWindowMs = 15 * 60 * 1000

export function authDateToEpochMilliseconds(
  value: unknown,
): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : undefined
  }

  if (typeof value === "string" || typeof value === "number") {
    const timestamp = new Date(value).getTime()
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
}

async function resolveOwnerSession(
  context: Parameters<MiddlewareHandler<AppBindings>>[0],
): Promise<Principal | Response> {
  const inspection = inspectCredentialCarriers(context.req.raw)
  const bodyAccessToken = await hasUnsupportedBodyAccessToken(context.req.raw)

  if (inspection.invalid || bodyAccessToken) {
    return problem(context, {
      detail:
        "The request contains an invalid or ambiguous credential carrier.",
      slug: "invalid-request",
    })
  }

  if (
    inspection.carriers.length !== 1 ||
    inspection.carriers[0] !== "session"
  ) {
    return problem(context, {
      detail: "A valid owner session is required.",
      slug: "authentication-required",
    })
  }

  try {
    const auth = await getInitializedAuth(context.env)
    const result = await auth.api.getSession({
      headers: context.req.raw.headers,
    })

    if (!result) {
      return problem(context, {
        detail: "A valid owner session is required.",
        slug: "invalid-credential",
      })
    }

    const config = getRuntimeConfig(context.env)
    const ownerAccount = await context.env.DB.prepare(
      `SELECT 1
       FROM account
       WHERE userId = ?1 AND providerId = 'github' AND accountId = ?2
       LIMIT 1`,
    )
      .bind(result.user.id, config.ownerGitHubId)
      .first()

    if (!ownerAccount) {
      return problem(context, {
        detail: "A valid owner session is required.",
        slug: "invalid-credential",
      })
    }

    const session = result.session as typeof result.session & {
      reauthenticatedAt?: unknown
    }
    const reauthenticatedAt = authDateToEpochMilliseconds(
      session.reauthenticatedAt,
    )

    return {
      authMethod: "session",
      permissions: [],
      ...(reauthenticatedAt === undefined ? {} : { reauthenticatedAt }),
      scopes: [],
      subject: result.user.id,
    }
  } catch (error) {
    console.error({
      event: "session_dependency_failed",
      message: error instanceof Error ? error.name : "unknown_error",
      requestId: context.get("requestId"),
    })

    return problem(context, {
      detail: "The session could not be verified.",
      slug: "service-unavailable",
    })
  }
}

export const requireOwnerSession: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const principal = await resolveOwnerSession(context)

  if (principal instanceof Response) {
    return principal
  }

  context.set("principal", principal)
  await next()
}

export const requireRecentOwnerSession: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const principal = await resolveOwnerSession(context)

  if (principal instanceof Response) {
    scheduleAuditEvent(context, {
      metadata: { reason: "credential_rejected", status: principal.status },
      outcome: "failure",
      type: "sensitive_operation_denied",
    })
    return principal
  }

  const authenticationAge =
    principal.reauthenticatedAt === undefined
      ? undefined
      : Date.now() - principal.reauthenticatedAt

  if (
    authenticationAge === undefined ||
    authenticationAge < 0 ||
    authenticationAge > recentAuthenticationWindowMs
  ) {
    scheduleAuditEvent(context, {
      metadata: { reason: "recent_authentication_required", status: 403 },
      outcome: "failure",
      subjectId: principal.subject,
      type: "sensitive_operation_denied",
    })
    return problem(context, {
      detail:
        "This operation requires authentication within the last 15 minutes.",
      slug: "recent-authentication-required",
    })
  }

  context.set("principal", principal)
  await next()
}

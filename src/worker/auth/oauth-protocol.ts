import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider"
import type { Context, MiddlewareHandler } from "hono"

import {
  enabledOAuthClients,
  oauthScopes,
  OAUTH_RESOURCE,
} from "../../shared/oauth"
import { getInitializedAuth } from "../auth"
import { getRuntimeConfig } from "../config"
import type { AppBindings } from "../http/types"
import { hasUnsupportedBodyAccessToken } from "./carriers"

export const oauthMetadataPaths = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
] as const

const knownScopes = new Set<string>(oauthScopes)
const apiScopes = ["api:read", "api:write"] as const
const oauthBearerInvalidRequestChallenge =
  'Bearer realm="eruoo-api", error="invalid_request"'

type OAuthErrorCode =
  | "invalid_client"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_target"
  | "temporarily_unavailable"

interface OAuthValidationFailure {
  error: OAuthErrorCode
  errorDescription: string
}

const oauthFormMediaType = "application/x-www-form-urlencoded"

function oauthError(
  context: Context<AppBindings>,
  failure: OAuthValidationFailure,
  status: 400 | 503 = 400,
): Response {
  return context.json(
    {
      error: failure.error,
      error_description: failure.errorDescription,
    },
    status,
    { "Cache-Control": "no-store" },
  )
}

export function oauthTokenRequestBodyTooLarge(
  context: Context<AppBindings>,
): Response {
  return oauthError(context, {
    error: "invalid_request",
    errorDescription: "the token request body exceeds the 1 MiB limit",
  })
}

export function oauthTokenServiceUnavailable(
  context: Context<AppBindings>,
): Response {
  return context.json(
    {
      code: "OAUTH_TOKEN_SERVICE_UNAVAILABLE",
      message: "The OAuth token service is temporarily unavailable.",
    },
    503,
    { "Cache-Control": "no-store" },
  )
}

export function isCanonicalOAuthScope(value: string): boolean {
  const scopes = value.split(" ")

  return (
    value.length > 0 &&
    value === scopes.join(" ") &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) => knownScopes.has(scope)) &&
    (!scopes.includes("profile") || scopes.includes("openid"))
  )
}

function validateScopeValues(
  values: readonly string[],
): OAuthValidationFailure | undefined {
  if (values.length > 1 || (values[0] && !isCanonicalOAuthScope(values[0]))) {
    return {
      error: "invalid_scope",
      errorDescription:
        "scope must be a unique, canonical list of supported values",
    }
  }
}

function validateResourceValues(
  values: readonly string[],
  required: boolean,
): OAuthValidationFailure | undefined {
  if (
    (required && values.length === 0) ||
    values.some((resource) => resource !== OAUTH_RESOURCE)
  ) {
    return {
      error: "invalid_target",
      errorDescription: `resource must be exactly ${OAUTH_RESOURCE}`,
    }
  }
}

function isValidEncodedFormComponent(value: string): boolean {
  try {
    decodeURIComponent(value.replaceAll("+", " "))
    return true
  } catch {
    return false
  }
}

function isStrictUrlEncodedForm(value: string): boolean {
  return value.split("&").every((entry) => {
    const separatorIndex = entry.indexOf("=")
    const name = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex)
    const fieldValue =
      separatorIndex === -1 ? "" : entry.slice(separatorIndex + 1)

    return (
      isValidEncodedFormComponent(name) &&
      isValidEncodedFormComponent(fieldValue)
    )
  })
}

export async function parseOAuthFormRequest(
  request: Request,
): Promise<URLSearchParams | undefined> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== oauthFormMediaType) return undefined

  try {
    const encoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(await request.clone().arrayBuffer())
    if (!isStrictUrlEncodedForm(encoded)) return undefined
    return new URLSearchParams(encoded)
  } catch {
    return undefined
  }
}

export const validateOAuthUserInfoRequest: MiddlewareHandler<
  AppBindings
> = async (context, next) => {
  const queryHasAccessToken = new URL(context.req.url).searchParams.has(
    "access_token",
  )
  const bodyHasAccessToken = await hasUnsupportedBodyAccessToken(
    context.req.raw,
  )

  if (!queryHasAccessToken && !bodyHasAccessToken) {
    await next()
    return
  }

  const response = oauthError(context, {
    error: "invalid_request",
    errorDescription:
      "access_token must be provided only in the Authorization header",
  })
  response.headers.set("WWW-Authenticate", oauthBearerInvalidRequestChallenge)
  return response
}

async function readFormValues(
  context: Context<AppBindings>,
): Promise<Response | URLSearchParams> {
  const values = await parseOAuthFormRequest(context.req.raw)

  if (!values) {
    return oauthError(context, {
      error: "invalid_request",
      errorDescription:
        "the request body must be valid application/x-www-form-urlencoded data",
    })
  }

  return values
}

interface OAuthClientRow {
  disabled: number | null
  redirectUris: string
  requirePKCE: number | null
  tokenEndpointAuthMethod: string | null
}

function matchesRegisteredRedirect(
  requestedValue: string,
  registeredValues: readonly string[],
  applicationType: "native" | "web",
): boolean {
  if (registeredValues.includes(requestedValue)) return true
  if (applicationType !== "native") return false

  const requested =
    /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(\/[^#]*)$/.exec(
      requestedValue,
    )
  const requestedHost = requested?.[1]
  const requestedPort = requested?.[2]
  const requestedSuffix = requested?.[3]

  if (
    !requestedHost ||
    !requestedPort ||
    !requestedSuffix ||
    Number(requestedPort) > 65_535
  ) {
    return false
  }

  return registeredValues.some((registeredValue) => {
    const registered = new URL(registeredValue)
    const registeredHost = registered.hostname

    return (
      registered.protocol === "http:" &&
      registeredHost === requestedHost &&
      registered.port === "" &&
      registered.username === "" &&
      registered.password === "" &&
      registered.hash === "" &&
      `${registered.pathname}${registered.search}` === requestedSuffix
    )
  })
}

async function validateAuthorizationClient(
  context: Context<AppBindings>,
  clientIds: readonly string[],
  redirectUris: readonly string[],
): Promise<
  | { redirectUri: string }
  | {
      failure: OAuthValidationFailure
      redirectUri?: string
      status: 400 | 503
    }
> {
  const clientId = clientIds[0]
  const redirectUri = redirectUris[0]

  if (
    clientIds.length !== 1 ||
    redirectUris.length !== 1 ||
    !clientId ||
    !redirectUri
  ) {
    return {
      failure: {
        error: "invalid_request",
        errorDescription:
          "client_id and redirect_uri must each occur exactly once",
      },
      status: 400,
    }
  }

  const client = enabledOAuthClients.find(
    (candidate) => candidate.clientId === clientId,
  )
  if (!client) {
    return {
      failure: {
        error: "invalid_client",
        errorDescription: "the OAuth client is not enabled",
      },
      status: 400,
    }
  }

  if (
    !matchesRegisteredRedirect(
      redirectUri,
      client.redirectUris,
      client.applicationType,
    )
  ) {
    return {
      failure: {
        error: "invalid_request",
        errorDescription: "redirect_uri is not registered for this client",
      },
      status: 400,
    }
  }

  try {
    const row = await context.env.DB.prepare(
      `SELECT disabled, redirectUris, requirePKCE, tokenEndpointAuthMethod
       FROM oauthClient
       WHERE clientId = ?1
       LIMIT 1`,
    )
      .bind(clientId)
      .first<OAuthClientRow>()
    const storedRedirectUris = row
      ? (JSON.parse(row.redirectUris) as unknown)
      : undefined

    if (
      !row ||
      row.disabled !== 0 ||
      row.requirePKCE !== 1 ||
      row.tokenEndpointAuthMethod !== "none" ||
      !Array.isArray(storedRedirectUris) ||
      !storedRedirectUris.every((value) => typeof value === "string") ||
      JSON.stringify(storedRedirectUris) !== JSON.stringify(client.redirectUris)
    ) {
      return {
        failure: {
          error: "temporarily_unavailable",
          errorDescription: "the OAuth client configuration is unavailable",
        },
        redirectUri,
        status: 503,
      }
    }
  } catch (error) {
    console.error({
      error: error instanceof Error ? error.name : "unknown_error",
      event: "oauth_client_configuration_failed",
      requestId: context.get("requestId"),
    })
    return {
      failure: {
        error: "temporarily_unavailable",
        errorDescription: "the OAuth client configuration is unavailable",
      },
      redirectUri,
      status: 503,
    }
  }

  return { redirectUri }
}

function redirectAuthorizationError(
  context: Context<AppBindings>,
  redirectUri: string,
  failure: OAuthValidationFailure,
  state: string | undefined,
): Response {
  const target = new URL(redirectUri)
  target.searchParams.append("error", failure.error)
  target.searchParams.append("error_description", failure.errorDescription)
  target.searchParams.append("iss", getRuntimeConfig(context.env).appOrigin)
  if (state) target.searchParams.append("state", state)

  context.header("Cache-Control", "no-store")
  return context.redirect(target.toString(), 302)
}

function readStringValues(
  values: URLSearchParams,
  name: string,
): string[] | undefined {
  const entries = values.getAll(name)
  return entries
}

const oauthTokenSingletonFormParameters = [
  "grant_type",
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
] as const

const oauthRevocationSingletonFormParameters = [
  "client_id",
  "client_secret",
  "client_assertion",
  "client_assertion_type",
  "token",
  "token_type_hint",
] as const

function validateSingletonFormParameters(
  values: URLSearchParams,
  names: readonly string[],
): OAuthValidationFailure | undefined {
  const duplicateName = names.find((name) => values.getAll(name).length > 1)
  if (!duplicateName) return undefined

  return {
    error: "invalid_request",
    errorDescription: `${duplicateName} must not occur more than once`,
  }
}

export const validateOAuthAuthorizationRequest: MiddlewareHandler<
  AppBindings
> = async (context, next) => {
  const values =
    context.req.method === "GET"
      ? new URL(context.req.url).searchParams
      : await readFormValues(context)

  if (values instanceof Response) return values

  const clientIds = readStringValues(values, "client_id")
  const redirectUris = readStringValues(values, "redirect_uri")
  const scopes = readStringValues(values, "scope")
  const resources = readStringValues(values, "resource")
  const states = readStringValues(values, "state")
  if (!clientIds || !redirectUris || !scopes || !resources || !states) {
    return oauthError(context, {
      error: "invalid_request",
      errorDescription: "OAuth parameters must be plain text values",
    })
  }

  const client = await validateAuthorizationClient(
    context,
    clientIds,
    redirectUris,
  )
  if ("failure" in client) {
    if (client.redirectUri) {
      return redirectAuthorizationError(
        context,
        client.redirectUri,
        client.failure,
        states.length === 1 ? states[0] : undefined,
      )
    }

    return oauthError(context, client.failure, client.status)
  }

  if (states.length > 1) {
    return redirectAuthorizationError(
      context,
      client.redirectUri,
      {
        error: "invalid_request",
        errorDescription: "state must not occur more than once",
      },
      undefined,
    )
  }

  const scopeError = validateScopeValues(scopes)
  if (scopeError) {
    return redirectAuthorizationError(
      context,
      client.redirectUri,
      scopeError,
      states[0],
    )
  }

  const resourceError = validateResourceValues(resources, true)
  if (resourceError) {
    return redirectAuthorizationError(
      context,
      client.redirectUri,
      resourceError,
      states[0],
    )
  }

  await next()
}

export const validateOAuthTokenRequest: MiddlewareHandler<AppBindings> = async (
  context,
  next,
) => {
  const values = await readFormValues(context)
  if (values instanceof Response) return values

  const singletonError = validateSingletonFormParameters(
    values,
    oauthTokenSingletonFormParameters,
  )
  if (singletonError) return oauthError(context, singletonError)

  const scopes = readStringValues(values, "scope")
  const resources = readStringValues(values, "resource")
  if (!scopes || !resources) {
    return oauthError(context, {
      error: "invalid_request",
      errorDescription: "OAuth parameters must be plain text values",
    })
  }

  const scopeError = validateScopeValues(scopes)
  if (scopeError) return oauthError(context, scopeError)

  const grantType = values.get("grant_type")
  const requiresResource = grantType === "authorization_code"
  const resourceError = validateResourceValues(resources, requiresResource)
  if (resourceError) return oauthError(context, resourceError)

  await next()
}

export const validateOAuthRevocationRequest: MiddlewareHandler<
  AppBindings
> = async (context, next) => {
  const values = await readFormValues(context)
  if (values instanceof Response) return values

  const singletonError = validateSingletonFormParameters(
    values,
    oauthRevocationSingletonFormParameters,
  )
  if (singletonError) return oauthError(context, singletonError)

  await next()
}

function addPublicClientAuthenticationMethod(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("OAuth metadata authentication methods are invalid")
  }

  return [...new Set(["none", ...value])]
}

function normalizeMetadata(
  value: unknown,
  context: Context<AppBindings>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("OAuth metadata is invalid")
  }

  const metadata = { ...value } as Record<string, unknown>
  const config = getRuntimeConfig(context.env)

  metadata["issuer"] = config.appOrigin
  metadata["jwks_uri"] = `${config.appOrigin}/api/auth/jwks`
  metadata["scopes_supported"] = [...oauthScopes]
  metadata["token_endpoint_auth_methods_supported"] =
    addPublicClientAuthenticationMethod(
      metadata["token_endpoint_auth_methods_supported"],
    )
  metadata["revocation_endpoint_auth_methods_supported"] =
    addPublicClientAuthenticationMethod(
      metadata["revocation_endpoint_auth_methods_supported"],
    )
  delete metadata["registration_endpoint"]

  return metadata
}

export async function serveOAuthMetadata(
  context: Context<AppBindings>,
): Promise<Response> {
  const auth = await getInitializedAuth(context.env)
  const createMetadata =
    context.req.path === "/.well-known/oauth-authorization-server"
      ? oauthProviderAuthServerMetadata(auth)
      : oauthProviderOpenIdConfigMetadata(auth)
  const upstream = await createMetadata(context.req.raw)

  if (!upstream.ok) return upstream

  const metadata = normalizeMetadata(await upstream.json(), context)
  const headers = new Headers(upstream.headers)
  headers.set("Cache-Control", "public, max-age=300")

  return new Response(
    context.req.method === "HEAD" ? null : JSON.stringify(metadata),
    {
      headers,
      status: 200,
    },
  )
}

export function serveProtectedResourceMetadata(
  context: Context<AppBindings>,
): Response {
  const config = getRuntimeConfig(context.env)
  const metadata = {
    authorization_servers: [config.appOrigin],
    bearer_methods_supported: ["header"],
    resource: OAUTH_RESOURCE,
    scopes_supported: [...apiScopes],
  }

  return new Response(
    context.req.method === "HEAD" ? null : JSON.stringify(metadata),
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json; charset=UTF-8",
      },
      status: 200,
    },
  )
}

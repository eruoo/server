import { createLocalJWKSet, jwtVerify } from "jose"

import {
  AI_AUTHORIZATION_POLL_DEFAULT_INTERVAL_MS,
  AI_AUTHORIZATION_POLL_MIN_INTERVAL_MS,
} from "../../shared/ai"
import type { AiProviderType } from "../../shared/ai"

/**
 * Fixed openai-codex connector definition.
 *
 * Every address, the client identifier, and the wire shapes below come from
 * the pinned reference implementations recorded in
 * docs/specs/ai-service.md §14 (codex-rs a8964cb device login, OpenCode
 * e03db9b connector, CLIProxyAPI 7bbfeaf stream handling). The connector is a
 * version-dependent compatibility integration: nothing here is configurable,
 * and callers can never override the target origin, host headers, or
 * authorization headers. Unknown upstream behavior surfaces as a typed
 * failure instead of a guess.
 *
 * Contract notes pinned from the references:
 * - Device verification page: `{issuer}/codex/device`.
 * - User code request: POST `{issuer}/api/accounts/deviceauth/usercode` with
 *   JSON `{client_id}`; the response carries `interval` as a *string*.
 * - Token poll: POST `{issuer}/api/accounts/deviceauth/token` with JSON
 *   `{device_auth_id, user_code}`; 2xx hands out the authorization code plus
 *   the PKCE verifier, 403/404 mean still pending, anything else is terminal.
 * - Code exchange: POST `{issuer}/oauth/token` as form-urlencoded
 *   authorization_code with redirect_uri `{issuer}/deviceauth/callback`.
 * - Refresh: POST `{issuer}/oauth/token` as JSON; every token field is
 *   optional and callers merge with the stored package. A 400 `invalid_grant`
 *   (or the legacy refresh_token_expired/reused/invalidated codes) and any 401
 *   are definitive terminal failures per the reference classifier.
 * - Model catalog: GET `{modelsBaseUrl}/models?client_version=…`.
 */

export const CODEX_PROVIDER_TYPE: AiProviderType = "openai-codex"

/** Reference CLI version used for the model catalog's client_version gating. */
export const CODEX_REFERENCE_CLIENT_VERSION = "0.154.0"

const CODEX_ISSUER = "https://auth.openai.com"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`
const CODEX_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`
const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`
const CODEX_JWKS_URL = `${CODEX_ISSUER}/.well-known/jwks.json`
const CODEX_MODELS_BASE_URL = "https://chatgpt.com/backend-api/codex"

const CODEX_UPSTREAM_ORIGINATOR = "eruoo"
const CODEX_UPSTREAM_USER_AGENT = "eruoo/1"

const CODEX_UPSTREAM_RESPONSE_BODY_LIMIT = 1_048_576
/** Error bodies exceeding this bound are discarded, never truncated. */
const CODEX_UPSTREAM_ERROR_BODY_LIMIT = 4_096

export interface CodexProviderDefinition {
  authorizationKind: "device-code"
  deviceVerificationUrl: string
  issuer: string
  providerType: AiProviderType
  /** Supported protocol capability, confirmed by the fixed references only. */
  responsesStyle: "responses-subset"
}

export function getCodexProviderDefinition(): CodexProviderDefinition {
  return {
    authorizationKind: "device-code",
    deviceVerificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    issuer: CODEX_ISSUER,
    providerType: CODEX_PROVIDER_TYPE,
    responsesStyle: "responses-subset",
  }
}

/** Budgeted upstream call inputs; every network path accepts both. */
export interface CodexUpstreamCallOptions {
  signal?: AbortSignal
  timeoutMs: number
}

/** Internal, allowlisted metadata; never part of the public API or audit data. */
export interface CodexModelResponseDiagnostics {
  cfMitigated: "challenge" | "absent" | "other"
  contentType: "json" | "html" | "other" | "absent"
  cfRay?: string
  upstreamRequestId?: string
}

function readModelResponseDiagnostics(
  headers: Headers,
): CodexModelResponseDiagnostics {
  const mitigated = headers.get("cf-mitigated")
  const rawContentType = headers.get("content-type")
  const mediaType =
    rawContentType !== null && rawContentType.length <= 256
      ? rawContentType.split(";", 1)[0]?.trim().toLowerCase()
      : undefined
  const cfRay = headers.get("cf-ray")
  const requestId = headers.get("x-request-id")
  return {
    cfMitigated:
      mitigated === null
        ? "absent"
        : mitigated === "challenge"
          ? "challenge"
          : "other",
    contentType:
      rawContentType === null
        ? "absent"
        : mediaType === "application/json"
          ? "json"
          : mediaType === "text/html"
            ? "html"
            : "other",
    ...(cfRay !== null &&
    cfRay.length === 20 &&
    /^[a-fA-F0-9]{16}-[A-Z]{3}$/.test(cfRay)
      ? { cfRay }
      : {}),
    ...(requestId !== null &&
    requestId.length <= 68 &&
    /^(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}|req_[a-zA-Z0-9]{16,64})$/.test(
      requestId,
    )
      ? { upstreamRequestId: requestId }
      : {}),
  }
}

export type CodexUpstreamFailure =
  | { kind: "network"; cause: string }
  /**
   * Non-2xx outcome. `body` carries a bounded upstream error
   * body for internal classification only (the refresh rejection codes); it
   * is never surfaced in results, responses, or logs.
   */
  | {
      kind: "http"
      status: number
      body?: string
      modelResponseDiagnostics?: CodexModelResponseDiagnostics
    }
  | { kind: "protocol"; detail: string }

export type CodexUpstreamCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: CodexUpstreamFailure }

function composeAbortSignal(
  options: CodexUpstreamCallOptions,
): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  return options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout])
}

async function readBoundedText(
  response: Response,
  limitBytes: number,
): Promise<string> {
  // The composed abort signal errors the response body stream as well, so
  // the single-call budget includes the response body as the design requires.
  const reader = response.body?.getReader()
  if (reader === undefined) return response.text()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limitBytes) {
        await reader.cancel()
        throw new UpstreamBodyLimitError()
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
  return new TextDecoder().decode(body)
}

class UpstreamBodyLimitError extends Error {
  constructor() {
    super("upstream response body exceeds the connector limit")
    this.name = "UpstreamBodyLimitError"
  }
}

async function fetchUpstream(
  url: string,
  init: {
    method: "POST" | "GET"
    body?: string
    contentType?: string
    headers?: Record<string, string>
  },
  options: CodexUpstreamCallOptions,
  diagnosticScope?: "model-catalog",
): Promise<CodexUpstreamCallResult<string>> {
  try {
    const response = await fetch(url, {
      body: init.body,
      headers: {
        ...init.headers,
        ...(init.contentType === undefined
          ? {}
          : { "content-type": init.contentType }),
        originator: CODEX_UPSTREAM_ORIGINATOR,
        "user-agent": CODEX_UPSTREAM_USER_AGENT,
      },
      method: init.method,
      signal: composeAbortSignal(options),
    })
    if (!(response.status >= 200 && response.status <= 299)) {
      const modelResponseDiagnostics =
        diagnosticScope === "model-catalog"
          ? readModelResponseDiagnostics(response.headers)
          : undefined
      // A bounded error body is kept for internal classification; the
      // text itself is never surfaced: upstream error bodies are not part of
      // the fixed contract and must not leak into results or logs.
      let body: string | undefined
      try {
        body = await readBoundedText(response, CODEX_UPSTREAM_ERROR_BODY_LIMIT)
      } catch {
        body = undefined
      }
      return {
        ok: false,
        failure: {
          body,
          kind: "http",
          status: response.status,
          ...(modelResponseDiagnostics === undefined
            ? {}
            : { modelResponseDiagnostics }),
        },
      }
    }
    return {
      ok: true,
      value: await readBoundedText(
        response,
        CODEX_UPSTREAM_RESPONSE_BODY_LIMIT,
      ),
    }
  } catch (error) {
    if (error instanceof UpstreamBodyLimitError) {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          detail: "response body exceeds the connector limit",
        },
      }
    }
    return {
      ok: false,
      failure: {
        kind: "network",
        cause: error instanceof Error ? error.name : "unknown",
      },
    }
  }
}

function parseJsonPayload(raw: string): CodexUpstreamCallResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "invalid JSON body" },
    }
  }
}

function readNonEmptyString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Normalizes the upstream poll interval. The fixed contract sends it as a
 * string; unparseable or missing values fall back to the 5-second default.
 * A parseable value below the 1-second floor is clamped up to it — a numeric
 * instruction is honored, never discarded.
 */
export function normalizeCodexPollIntervalMs(value: unknown): number {
  let seconds: number
  if (typeof value === "number") seconds = value
  else if (typeof value === "string") seconds = Number(value.trim())
  else seconds = Number.NaN
  if (!Number.isFinite(seconds)) {
    seconds = AI_AUTHORIZATION_POLL_DEFAULT_INTERVAL_MS / 1_000
  }
  const milliseconds = Math.round(Math.max(seconds, 0) * 1_000)
  if (!Number.isSafeInteger(milliseconds)) {
    return AI_AUTHORIZATION_POLL_DEFAULT_INTERVAL_MS
  }
  return Math.max(AI_AUTHORIZATION_POLL_MIN_INTERVAL_MS, milliseconds)
}

export interface CodexDeviceUserCode {
  deviceAuthId: string
  intervalMs: number
  userCode: string
}

export async function requestCodexDeviceUserCode(
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<CodexDeviceUserCode>> {
  const response = await fetchUpstream(
    CODEX_USERCODE_URL,
    {
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      contentType: "application/json",
      method: "POST",
    },
    options,
  )
  if (!response.ok) return response
  const parsed = parseJsonPayload(response.value)
  if (!parsed.ok) return parsed
  if (typeof parsed.value !== "object" || parsed.value === null) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "usercode payload is not an object",
      },
    }
  }
  const payload = parsed.value as Record<string, unknown>
  // The reference accepts `user_code` with a `usercode` alias.
  const userCode =
    readNonEmptyString(payload, "user_code") ??
    readNonEmptyString(payload, "usercode")
  const deviceAuthId = readNonEmptyString(payload, "device_auth_id")
  if (userCode === undefined || deviceAuthId === undefined) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "usercode payload misses required fields",
      },
    }
  }
  return {
    ok: true,
    value: {
      deviceAuthId,
      intervalMs: normalizeCodexPollIntervalMs(payload.interval),
      userCode,
    },
  }
}

export type CodexDeviceAuthorizationPollResult =
  | { status: "pending" }
  | {
      status: "authorized"
      authorizationCode: string
      codeVerifier: string
    }

export async function pollCodexDeviceAuthorization(
  input: { deviceAuthId: string; userCode: string },
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<CodexDeviceAuthorizationPollResult>> {
  const response = await fetchUpstream(
    CODEX_DEVICE_TOKEN_URL,
    {
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
      contentType: "application/json",
      method: "POST",
    },
    options,
  )
  if (!response.ok) {
    const { failure } = response
    // 403/404 mean the grant is still pending per the fixed reference; every
    // other outcome is terminal for this authorization attempt.
    if (
      failure.kind === "http" &&
      (failure.status === 403 || failure.status === 404)
    ) {
      return { ok: true, value: { status: "pending" } }
    }
    return { ok: false, failure }
  }
  const parsed = parseJsonPayload(response.value)
  if (!parsed.ok) return parsed
  if (typeof parsed.value !== "object" || parsed.value === null) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "device token payload is not an object",
      },
    }
  }
  const payload = parsed.value as Record<string, unknown>
  const authorizationCode = readNonEmptyString(payload, "authorization_code")
  const codeVerifier = readNonEmptyString(payload, "code_verifier")
  if (authorizationCode === undefined || codeVerifier === undefined) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "device token payload misses required fields",
      },
    }
  }
  return {
    ok: true,
    value: { status: "authorized", authorizationCode, codeVerifier },
  }
}

export interface CodexTokenSet {
  accessToken: string
  expiresIn?: number
  idToken: string
  refreshToken: string
}

function readExpiresIn(source: Record<string, unknown>): number | undefined {
  const value = source.expires_in
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value
  }
  return undefined
}

export async function exchangeCodexAuthorizationCode(
  input: { authorizationCode: string; codeVerifier: string },
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<CodexTokenSet>> {
  // Parameter order mirrors the fixed reference exchange request.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.codeVerifier,
  })
  const response = await fetchUpstream(
    CODEX_TOKEN_URL,
    {
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded",
      method: "POST",
    },
    options,
  )
  if (!response.ok) return response
  const parsed = parseJsonPayload(response.value)
  if (!parsed.ok) return parsed
  if (typeof parsed.value !== "object" || parsed.value === null) {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "token payload is not an object" },
    }
  }
  const payload = parsed.value as Record<string, unknown>
  const accessToken = readNonEmptyString(payload, "access_token")
  const idToken = readNonEmptyString(payload, "id_token")
  const refreshToken = readNonEmptyString(payload, "refresh_token")
  if (
    accessToken === undefined ||
    idToken === undefined ||
    refreshToken === undefined
  ) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "token payload misses required fields",
      },
    }
  }
  return {
    ok: true,
    value: {
      accessToken,
      expiresIn: readExpiresIn(payload),
      idToken,
      refreshToken,
    },
  }
}

/**
 * Refreshes the access token. The fixed contract returns every token field
 * optionally and callers merge with the stored package; a response carrying
 * neither an access nor a refresh token proves nothing was refreshed and is
 * reported as a protocol failure instead of a silent no-op.
 */
export async function refreshCodexAccessToken(
  input: { refreshToken: string },
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<Partial<CodexTokenSet>>> {
  const response = await fetchUpstream(
    CODEX_TOKEN_URL,
    {
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
      contentType: "application/json",
      method: "POST",
    },
    options,
  )
  if (!response.ok) return response
  const parsed = parseJsonPayload(response.value)
  if (!parsed.ok) return parsed
  if (typeof parsed.value !== "object" || parsed.value === null) {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "refresh payload is not an object" },
    }
  }
  const payload = parsed.value as Record<string, unknown>
  const accessToken = readNonEmptyString(payload, "access_token")
  const idToken = readNonEmptyString(payload, "id_token")
  const refreshToken = readNonEmptyString(payload, "refresh_token")
  if (accessToken === undefined && refreshToken === undefined) {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "refresh payload carries no token" },
    }
  }
  return {
    ok: true,
    value: {
      ...(accessToken === undefined ? {} : { accessToken }),
      expiresIn: readExpiresIn(payload),
      ...(idToken === undefined ? {} : { idToken }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
    },
  }
}

/** Error codes the fixed reference classifies as a definitive grant failure. */
const definitiveRefreshRejectionCodes = new Set([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
])

function extractRefreshErrorCode(body: string | undefined): string | null {
  if (body === undefined || body.trim() === "") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const error = record.error
  // The reference accepts `error` as a string code or as a nested
  // `{code, message}` object, plus a top-level `code` fallback.
  if (typeof error === "string" && error !== "") return error
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code !== ""
  ) {
    return (error as { code: string }).code
  }
  if (typeof record.code === "string" && record.code !== "") return record.code
  return null
}

/**
 * Classifies a refresh failure against the reference classifier: a 401, or a
 * 400 whose body carries `invalid_grant` (or the legacy
 * refresh_token_expired/reused/invalidated codes, possibly nested), is a
 * definitive terminal rejection. Every other 400 code is Transient in the
 * reference — but this service never replays a refresh token whose
 * consumption state is unknown, so those outcomes are reported as unknown
 * (not definitive) and the lifecycle moves the connection into
 * reauthentication required either way.
 */
export function isDefinitiveCodexRefreshRejection(
  failure: CodexUpstreamFailure,
): boolean {
  if (failure.kind !== "http") return false
  if (failure.status === 401) return true
  if (failure.status !== 400) return false
  return definitiveRefreshRejectionCodes.has(
    (extractRefreshErrorCode(failure.body) ?? "").toLowerCase(),
  )
}

export interface CodexModelCatalogEntry {
  displayName: string | null
  /** Confirmed capability facts as reported by the fixed catalog contract. */
  reasoningEfforts: string[]
  slug: string
  supportedInApi: boolean
  visibility: string | null
}

const CODEX_MODEL_CATALOG_MAX_ENTRIES = 200

export async function listCodexModels(
  input: { accessToken: string; accountId: string | null },
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<CodexModelCatalogEntry[]>> {
  const url = `${CODEX_MODELS_BASE_URL}/models?client_version=${CODEX_REFERENCE_CLIENT_VERSION}`
  const response = await fetchUpstream(
    url,
    {
      headers: {
        ...(input.accountId === null
          ? {}
          : { "chatgpt-account-id": input.accountId }),
        authorization: `Bearer ${input.accessToken}`,
      },
      method: "GET",
    },
    options,
    "model-catalog",
  )
  if (!response.ok) return response
  const parsed = parseJsonPayload(response.value)
  if (!parsed.ok) return parsed
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    !Array.isArray((parsed.value as { models?: unknown }).models)
  ) {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "model catalog payload is invalid" },
    }
  }
  const models = (parsed.value as { models: unknown[] }).models
  if (models.length > CODEX_MODEL_CATALOG_MAX_ENTRIES) {
    return {
      ok: false,
      failure: {
        kind: "protocol",
        detail: "model catalog exceeds the storage limit",
      },
    }
  }
  const entries: CodexModelCatalogEntry[] = []
  for (const model of models) {
    if (typeof model !== "object" || model === null) {
      return {
        ok: false,
        failure: { kind: "protocol", detail: "model catalog entry is invalid" },
      }
    }
    const record = model as Record<string, unknown>
    const slug = readNonEmptyString(record, "slug")
    if (slug === undefined) {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          detail: "model catalog entry misses its slug",
        },
      }
    }
    // Capability facts are kept exactly as reported; anything missing stays
    // unconfirmed and is never inferred from the model name.
    const displayName = readNonEmptyString(record, "display_name") ?? null
    const visibilityValue = record.visibility
    const visibility =
      typeof visibilityValue === "string" && visibilityValue.length > 0
        ? visibilityValue
        : null
    const supportedInApi = record.supported_in_api === true
    const reasoningEfforts: string[] = []
    if (Array.isArray(record.supported_reasoning_levels)) {
      for (const level of record.supported_reasoning_levels) {
        if (
          typeof level === "object" &&
          level !== null &&
          typeof (level as { effort?: unknown }).effort === "string" &&
          ((level as { effort: unknown }).effort as string).length > 0
        ) {
          reasoningEfforts.push((level as { effort: string }).effort)
        }
      }
    }
    entries.push({
      displayName,
      reasoningEfforts,
      slug,
      supportedInApi,
      visibility,
    })
  }
  return { ok: true, value: entries }
}

/**
 * Builds the fixed Responses invocation request. The target address and every
 * header come from the pinned reference (CLIProxyAPI 7bbfeaf
 * codex_executor_stream.go: `baseURL + "/responses"`; codex_executor_request.go
 * applyCodexHeadersFromSources: JSON content type, bearer authorization, the
 * workspace account header, the originator/user-agent identity, and an
 * Accept that follows the streaming mode). Callers can never override the
 * origin, host, or authorization.
 */
export function buildCodexResponsesRequest(input: {
  accessToken: string
  accountId: string | null
  stream: boolean
}): { headers: Record<string, string>; url: string } {
  return {
    headers: {
      ...buildCodexBackendRequestHeaders({
        accessToken: input.accessToken,
        accountId: input.accountId,
      }),
      accept: input.stream ? "text/event-stream" : "application/json",
      "content-type": "application/json",
    },
    url: `${CODEX_MODELS_BASE_URL}/responses`,
  }
}

/** Headers the connector sets on authenticated backend (models/responses) calls. */
export function buildCodexBackendRequestHeaders(input: {
  accessToken: string
  accountId: string | null
}): Record<string, string> {
  return {
    ...(input.accountId === null
      ? {}
      : { "chatgpt-account-id": input.accountId }),
    authorization: `Bearer ${input.accessToken}`,
    originator: CODEX_UPSTREAM_ORIGINATOR,
    "user-agent": CODEX_UPSTREAM_USER_AGENT,
  }
}

export interface CodexAccountIdentity {
  /** ChatGPT workspace (account) identifier; required for connection binding. */
  chatgptAccountId: string
  chatgptPlanType: string | null
  /** ChatGPT user identifier; optional in the upstream claims. */
  chatgptUserId: string | null
  email: string | null
}

interface CodexIdTokenAuthClaims {
  chatgpt_account_id?: unknown
  chatgpt_plan_type?: unknown
  chatgpt_user_id?: unknown
}

function readIdentityClaimString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * Verifies the ID token from the code exchange: signature against the issuer
 * JWKS (RS256), the exact issuer, the fixed client audience, and the expiry.
 * The account identity is extracted from the verified claims only. The JWKS
 * is fetched per verification inside the caller's budget; it is never cached
 * across requests.
 */
export async function verifyCodexIdToken(
  idToken: string,
  options: CodexUpstreamCallOptions,
): Promise<CodexUpstreamCallResult<CodexAccountIdentity>> {
  const jwksResponse = await fetchUpstream(
    CODEX_JWKS_URL,
    { method: "GET" },
    options,
  )
  if (!jwksResponse.ok) return jwksResponse
  const parsedJwks = parseJsonPayload(jwksResponse.value)
  if (!parsedJwks.ok) return parsedJwks
  let jwks: ReturnType<typeof createLocalJWKSet>
  try {
    jwks = createLocalJWKSet(parsedJwks.value as never)
  } catch {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "JWKS payload is invalid" },
    }
  }
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      algorithms: ["RS256"],
      audience: CODEX_CLIENT_ID,
      clockTolerance: 0,
      issuer: CODEX_ISSUER,
    })
    const claims = payload as typeof payload & {
      "https://api.openai.com/auth"?: CodexIdTokenAuthClaims
      "https://api.openai.com/profile"?: { email?: unknown }
    }
    const authClaims = claims["https://api.openai.com/auth"]
    const chatgptAccountId = readIdentityClaimString(
      authClaims?.chatgpt_account_id,
    )
    if (chatgptAccountId === null) {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          detail: "id token carries no account identity",
        },
      }
    }
    if (chatgptAccountId.length > 128) {
      return {
        ok: false,
        failure: {
          kind: "protocol",
          detail: "id token account identity is invalid",
        },
      }
    }
    return {
      ok: true,
      value: {
        chatgptAccountId,
        chatgptPlanType: readIdentityClaimString(authClaims?.chatgpt_plan_type),
        chatgptUserId: readIdentityClaimString(authClaims?.chatgpt_user_id),
        email:
          readIdentityClaimString(claims.email) ??
          readIdentityClaimString(
            claims["https://api.openai.com/profile"]?.email,
          ),
      },
    }
  } catch {
    return {
      ok: false,
      failure: { kind: "protocol", detail: "id token verification failed" },
    }
  }
}

/**
 * Reads the access token's `exp` claim without signature verification — the
 * token only ever arrives from the authenticated token endpoint over TLS. It
 * is a JWT per the fixed reference; a missing or unparseable claim yields
 * null and the caller falls back to its recorded default.
 */
export function readCodexAccessTokenExpiryMs(
  accessToken: string,
): number | null {
  const parts = accessToken.split(".")
  if (
    parts.length !== 3 ||
    parts[0] === "" ||
    parts[1] === "" ||
    parts[2] === ""
  ) {
    return null
  }
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    ) as { exp?: unknown }
    if (
      typeof decoded.exp === "number" &&
      Number.isSafeInteger(decoded.exp) &&
      decoded.exp > 0
    ) {
      return decoded.exp * 1_000
    }
    return null
  } catch {
    return null
  }
}

const SIGNATURE_PARAMETER = "sig"
const SIGNED_PARAMETER_NAME = "ba_param"
const EXPIRATION_PARAMETER = "exp"
const ISSUED_AT_PARAMETER = "ba_iat"
export const GITHUB_CALLBACK_ERROR_PARAMETERS = [
  "error",
  "error_description",
] as const

const loginLocationBase = "https://login.eruoo.invalid"

export type LoginUpstreamError = "other" | "owner-not-allowed"

export interface LoginContinuationLocation {
  callbackLocation: string
  normalizedLocation: string
  status: "absent" | "current" | "invalid"
  upstreamError: LoginUpstreamError | undefined
}

function locationFromUrl(url: URL): string {
  const query = url.searchParams.toString()
  return `${url.pathname}${query ? `?${query}` : ""}`
}

function hasContinuationMarker(params: URLSearchParams): boolean {
  return params.has(SIGNATURE_PARAMETER) || params.has(SIGNED_PARAMETER_NAME)
}

export function classifyGitHubCallbackError(
  params: URLSearchParams,
): LoginUpstreamError | undefined {
  const [errorParameter, errorDescriptionParameter] =
    GITHUB_CALLBACK_ERROR_PARAMETERS
  const errorValues = params.getAll(errorParameter)

  if (errorValues.length === 1 && errorValues[0] === "owner_not_allowed") {
    return "owner-not-allowed"
  }

  return errorValues.length > 0 || params.has(errorDescriptionParameter)
    ? "other"
    : undefined
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined

  return parsed
}

function currentSignedContinuation(
  params: URLSearchParams,
  now: number,
): URLSearchParams | undefined {
  const signatures = params.getAll(SIGNATURE_PARAMETER)
  const expirationValues = params.getAll(EXPIRATION_PARAMETER)
  const issuedAtValues = params.getAll(ISSUED_AT_PARAMETER)
  const signedParameterNames = params.getAll(SIGNED_PARAMETER_NAME)
  const uniqueSignedParameterNames = new Set(signedParameterNames)

  if (
    signatures.length !== 1 ||
    !signatures[0] ||
    expirationValues.length !== 1 ||
    issuedAtValues.length !== 1 ||
    signedParameterNames.length === 0 ||
    uniqueSignedParameterNames.size !== signedParameterNames.length ||
    !uniqueSignedParameterNames.has(SIGNED_PARAMETER_NAME) ||
    !uniqueSignedParameterNames.has(EXPIRATION_PARAMETER) ||
    !uniqueSignedParameterNames.has(ISSUED_AT_PARAMETER) ||
    uniqueSignedParameterNames.has(SIGNATURE_PARAMETER) ||
    GITHUB_CALLBACK_ERROR_PARAMETERS.some((name) =>
      uniqueSignedParameterNames.has(name),
    )
  ) {
    return undefined
  }

  const expirationSeconds = parsePositiveInteger(expirationValues[0] ?? null)
  const issuedAtMilliseconds = parsePositiveInteger(issuedAtValues[0] ?? null)

  if (
    expirationSeconds === undefined ||
    issuedAtMilliseconds === undefined ||
    expirationSeconds * 1_000 <= now ||
    issuedAtMilliseconds >= expirationSeconds * 1_000
  ) {
    return undefined
  }

  for (const parameterName of uniqueSignedParameterNames) {
    if (!parameterName || !params.has(parameterName)) return undefined
  }

  const signedParams = new URLSearchParams()
  for (const [name, value] of params) {
    if (
      name === SIGNATURE_PARAMETER ||
      name === SIGNED_PARAMETER_NAME ||
      uniqueSignedParameterNames.has(name)
    ) {
      signedParams.append(name, value)
    }
  }

  return signedParams
}

export function inspectLoginContinuationLocation(
  fullPath: string,
  now = Date.now(),
): LoginContinuationLocation {
  const url = new URL(fullPath, loginLocationBase)
  const upstreamError = classifyGitHubCallbackError(url.searchParams)
  const signedContinuation = currentSignedContinuation(url.searchParams, now)

  if (signedContinuation) {
    url.search = signedContinuation.toString()
    const continuationLocation = locationFromUrl(url)

    return {
      callbackLocation: continuationLocation,
      normalizedLocation: continuationLocation,
      status: "current",
      upstreamError,
    }
  }

  if (hasContinuationMarker(url.searchParams)) {
    url.search = ""

    return {
      callbackLocation: url.pathname,
      normalizedLocation: url.pathname,
      status: "invalid",
      upstreamError,
    }
  }

  for (const parameterName of GITHUB_CALLBACK_ERROR_PARAMETERS) {
    url.searchParams.delete(parameterName)
  }

  return {
    callbackLocation: url.pathname,
    normalizedLocation: locationFromUrl(url),
    status: "absent",
    upstreamError,
  }
}

export function isInvalidOAuthContinuationError(
  value: unknown,
  visited = new Set<object>(),
): boolean {
  if (typeof value === "string") return value === "invalid_signature"
  if (typeof value !== "object" || value === null || visited.has(value)) {
    return false
  }

  visited.add(value)

  for (const property of ["code", "error", "body", "cause", "response"]) {
    if (
      property in value &&
      isInvalidOAuthContinuationError(
        value[property as keyof typeof value],
        visited,
      )
    ) {
      return true
    }
  }

  return false
}

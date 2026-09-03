const bearerPattern = /^Bearer +[A-Za-z0-9\-._~+/]+={0,}$/i
const apiKeyPattern = /^[A-Za-z0-9_-]+$/
/**
 * Session token cookie 名。凭据载体检测只统计 token cookie：
 * session_data 是缓存副本，不计入载体集合，否则一次请求携带
 * token + data 会被误判为多载体 400。
 */
export const sessionTokenCookieNames = new Set([
  "eruoo.session_token",
  "__Secure-eruoo.session_token",
])
/** Session cookieCache data cookie 名。 */
export const sessionDataCookieNames = new Set([
  "eruoo.session_data",
  "__Secure-eruoo.session_data",
])
/** 全部 Session 相关 cookie 名（token + data），供 OAuth 权威预检使用。 */
export const sessionCookieNames = new Set([
  ...sessionTokenCookieNames,
  ...sessionDataCookieNames,
])

export type CredentialCarrier = "apiKey" | "bearer" | "session"

export interface CarrierInspection {
  carriers: CredentialCarrier[]
  invalid: boolean
}

export async function hasUnsupportedBodyAccessToken(
  request: Request,
): Promise<boolean> {
  if (
    request.body === null ||
    request.method === "GET" ||
    request.method === "HEAD"
  ) {
    return false
  }

  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase()

  try {
    if (
      contentType === "application/x-www-form-urlencoded" ||
      contentType === "multipart/form-data"
    ) {
      return (await request.clone().formData()).has("access_token")
    }

    if (contentType === "application/json" || contentType?.endsWith("+json")) {
      const body: unknown = await request.clone().json()
      return (
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        Object.hasOwn(body, "access_token")
      )
    }
  } catch {
    // The operation handler remains responsible for malformed body syntax.
  }

  return false
}

function inspectSessionCookies(cookieHeader: string | undefined): {
  count: number
  invalid: boolean
} {
  if (!cookieHeader) {
    return { count: 0, invalid: false }
  }

  let count = 0
  let invalid = false

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=")
    if (separator < 1) {
      if (sessionTokenCookieNames.has(pair.trim())) {
        count += 1
        invalid = true
      }
      continue
    }

    const name = pair.slice(0, separator).trim()
    if (!sessionTokenCookieNames.has(name)) {
      continue
    }

    count += 1
    if (pair.slice(separator + 1).trim().length === 0) {
      invalid = true
    }
  }

  return { count, invalid }
}

export function inspectCredentialCarriers(request: Request): CarrierInspection {
  const carriers: CredentialCarrier[] = []
  let invalid = false
  const authorization = request.headers.get("authorization")
  const apiKey = request.headers.get("x-api-key")
  const session = inspectSessionCookies(
    request.headers.get("cookie") ?? undefined,
  )

  if (authorization !== null) {
    carriers.push("bearer")
    invalid ||= !bearerPattern.test(authorization)
  }

  if (apiKey !== null) {
    carriers.push("apiKey")
    invalid ||= !apiKeyPattern.test(apiKey)
  }

  if (session.count > 0) {
    carriers.push("session")
    invalid ||= session.invalid || session.count !== 1
  }

  const url = new URL(request.url)
  invalid ||= url.searchParams.has("access_token")
  invalid ||= carriers.length > 1

  return { carriers, invalid }
}

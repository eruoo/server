import { findOAuthClient, type OAuthStaticClient } from "../../shared/oauth"
import { matchesOAuthClientRegistration } from "../../shared/oauth-registration"

export class OAuthClientPolicyError extends Error {
  constructor(readonly error: "invalid_client" | "temporarily_unavailable") {
    super(error)
    this.name = "OAuthClientPolicyError"
  }
}

/** Resolve only deployment-owned clients; a D1 row cannot enable a client. */
export async function readOAuthClientPolicy(
  database: D1Database,
  clientId: string,
): Promise<OAuthStaticClient> {
  const client = findOAuthClient(clientId)
  if (!client?.enabled) throw new OAuthClientPolicyError("invalid_client")
  try {
    const [registration, links] = await database.batch<Record<string, unknown>>(
      [
        database
          .prepare("SELECT * FROM oauthClient WHERE clientId=?")
          .bind(clientId),
        database
          .prepare(
            "SELECT resourceId FROM oauthClientResource WHERE clientId=? ORDER BY resourceId",
          )
          .bind(clientId),
      ],
    )
    if (
      registration?.results.length !== 1 ||
      !matchesOAuthClientRegistration(registration.results[0]!, client) ||
      JSON.stringify(links?.results.map((row) => row["resourceId"])) !==
        JSON.stringify([...client.resources].sort())
    )
      throw new OAuthClientPolicyError("temporarily_unavailable")
    return client
  } catch {
    throw new OAuthClientPolicyError("temporarily_unavailable")
  }
}

export function matchesRegisteredRedirect(
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
  const [, host, port, suffix] = requested ?? []
  if (!host || !port || !suffix || Number(port) > 65_535) return false
  return registeredValues.some((value) => {
    const registered = new URL(value)
    return (
      registered.protocol === "http:" &&
      registered.hostname === host &&
      registered.port === "" &&
      registered.username === "" &&
      registered.password === "" &&
      registered.hash === "" &&
      `${registered.pathname}${registered.search}` === suffix
    )
  })
}

export function clientAllowsScopes(
  client: OAuthStaticClient,
  scopes: readonly string[],
): boolean {
  return (
    scopes.length > 0 &&
    new Set(scopes).size === scopes.length &&
    scopes.every((scope) =>
      (client.scopes as readonly string[]).includes(scope),
    ) &&
    (!scopes.includes("profile") || scopes.includes("openid"))
  )
}

export function clientAllowsResources(
  client: OAuthStaticClient,
  resources: readonly string[],
): boolean {
  return (
    resources.length > 0 &&
    resources.every((resource) => client.resources.includes(resource))
  )
}

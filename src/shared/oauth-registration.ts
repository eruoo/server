import { enabledOAuthClients, type OAuthStaticClient } from "./oauth"

/** Security-relevant D1 fields shared by runtime admission and restore seeding. */
export function oauthClientRegistration(client: OAuthStaticClient) {
  return {
    clientId: client.clientId,
    clientSecret: null,
    clientDiscoveryId: null,
    disabled: Number(!client.enabled),
    skipConsent: Number(client.skipConsent),
    enableEndSession: Number(client.enableEndSession),
    subjectType: client.subjectType,
    scopes: JSON.stringify(client.scopes),
    clientCredentialsScopes: null,
    userId: null,
    redirectUris: JSON.stringify(client.redirectUris),
    postLogoutRedirectUris: null,
    backchannelLogoutUri: null,
    backchannelLogoutSessionRequired: null,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    applicationType: client.applicationType,
    jwks: null,
    jwksUri: null,
    grantTypes: JSON.stringify(client.grantTypes),
    responseTypes: JSON.stringify(client.responseTypes),
    requirePKCE: Number(client.requirePKCE),
    dpopBoundAccessTokens: Number(client.dpopBoundAccessTokens),
  }
}

export function matchesOAuthClientRegistration(
  row: Readonly<Record<string, unknown>>,
  client: OAuthStaticClient,
): boolean {
  return Object.entries(oauthClientRegistration(client)).every(
    ([field, expected]) => row[field] === expected,
  )
}

export function staticOAuthRegistrationSnapshot() {
  return {
    clients: enabledOAuthClients.map(oauthClientRegistration),
    links: enabledOAuthClients.flatMap((client) =>
      client.resources.map((resourceId) => ({
        clientId: client.clientId,
        resourceId,
      })),
    ),
  }
}

/** Full-set checks belong to release/restore validation, not request admission. */
export function assertStaticOAuthRegistrations(
  clients: readonly Record<string, unknown>[],
  links: readonly Record<string, unknown>[],
  expected = staticOAuthRegistrationSnapshot(),
): void {
  if (
    clients.length !== expected.clients.length ||
    expected.clients.some((policy) => {
      const matches = clients.filter(
        (row) => row["clientId"] === policy.clientId,
      )
      return (
        matches.length !== 1 ||
        !Object.entries(policy).every(
          ([key, value]) => matches[0]![key] === value,
        )
      )
    })
  )
    throw new Error("Static OAuth client registration mismatch")
  if (
    links.length !== expected.links.length ||
    expected.links.some(
      (link) =>
        links.filter(
          (row) =>
            row["clientId"] === link.clientId &&
            row["resourceId"] === link.resourceId,
        ).length !== 1,
    )
  )
    throw new Error("Static OAuth resource link mismatch")
}

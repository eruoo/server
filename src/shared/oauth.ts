const OAUTH_ISSUER = "https://auth.eruoo.me" as const
export const OAUTH_RESOURCE = `${OAUTH_ISSUER}/api` as const
export const OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 60 * 60
export const OAUTH_USERINFO_RESOURCE =
  `${OAUTH_ISSUER}/api/auth/oauth2/userinfo` as const
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/api" as const

export const oauthScopes = [
  "openid",
  "profile",
  "api:read",
  "api:write",
  "offline_access",
] as const

export type OAuthScope = (typeof oauthScopes)[number]
export type OAuthClientId = (typeof oauthClients)[number]["clientId"]
export type OAuthClientPlatform = "desktop" | "mobile" | "web"

export interface OAuthStaticClient {
  applicationType: "native" | "web"
  clientId: string
  enabled: boolean
  name: string
  platform: OAuthClientPlatform
  redirectUris: readonly string[]
  scopes: readonly OAuthScope[]
  tokenEndpointAuthMethod: "none"
  grantTypes: readonly ("authorization_code" | "refresh_token")[]
  responseTypes: readonly "code"[]
  resources: readonly string[]
  requirePKCE: true
  skipConsent: boolean
  enableEndSession: boolean
  subjectType: "public"
  dpopBoundAccessTokens: false
}

const publicCodeClient = {
  tokenEndpointAuthMethod: "none",
  responseTypes: ["code"],
  resources: [OAUTH_RESOURCE],
  requirePKCE: true,
  skipConsent: true,
  subjectType: "public",
  dpopBoundAccessTokens: false,
} as const

export const oauthClients = [
  {
    ...publicCodeClient,
    applicationType: "web",
    clientId: "eruoo-web",
    enabled: false,
    name: "eruoo Web",
    platform: "web",
    redirectUris: [],
    scopes: ["openid", "profile", "api:read", "api:write"],
    grantTypes: ["authorization_code"],
    enableEndSession: false,
  },
  {
    ...publicCodeClient,
    applicationType: "native",
    clientId: "eruoo-desktop",
    enabled: true,
    name: "eruoo Desktop",
    platform: "desktop",
    redirectUris: [
      "http://127.0.0.1/oauth/callback",
      "http://[::1]/oauth/callback",
    ],
    scopes: ["openid", "profile", "api:read", "api:write", "offline_access"],
    grantTypes: ["authorization_code", "refresh_token"],
    enableEndSession: true,
  },
  {
    ...publicCodeClient,
    applicationType: "native",
    clientId: "eruoo-mobile",
    enabled: false,
    name: "eruoo Mobile",
    platform: "mobile",
    redirectUris: [],
    scopes: ["openid", "profile", "api:read", "api:write", "offline_access"],
    grantTypes: ["authorization_code", "refresh_token"],
    enableEndSession: true,
  },
  {
    ...publicCodeClient,
    applicationType: "web",
    clientId: "hako-web",
    enabled: true,
    name: "Hako",
    platform: "web",
    redirectUris: ["https://hako.eruoo.me/api/auth/callback"],
    scopes: ["openid", "profile"],
    grantTypes: ["authorization_code"],
    enableEndSession: false,
  },
] as const satisfies readonly OAuthStaticClient[]

export const enabledOAuthClients = oauthClients.filter(
  (client) => client.enabled,
)

export const enabledOAuthClientIds = new Set(
  enabledOAuthClients.map((client) => client.clientId),
)

export function supportsOfflineAccess(client: OAuthStaticClient): boolean {
  return (
    client.grantTypes.includes("refresh_token") &&
    client.scopes.includes("offline_access")
  )
}

export function findOAuthClient(clientId: string) {
  return oauthClients.find((client) => client.clientId === clientId)
}

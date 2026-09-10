export const OAUTH_ISSUER = "https://auth.eruoo.me" as const
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
  clientId: "eruoo-desktop" | "eruoo-mobile" | "eruoo-web"
  enabled: boolean
  name: string
  platform: OAuthClientPlatform
  redirectUris: readonly string[]
  scopes: readonly OAuthScope[]
  supportsOfflineAccess: boolean
}

export const oauthClients = [
  {
    applicationType: "web",
    clientId: "eruoo-web",
    enabled: false,
    name: "eruoo Web",
    platform: "web",
    redirectUris: [],
    scopes: ["openid", "profile", "api:read", "api:write"],
    supportsOfflineAccess: false,
  },
  {
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
    supportsOfflineAccess: true,
  },
  {
    applicationType: "native",
    clientId: "eruoo-mobile",
    enabled: false,
    name: "eruoo Mobile",
    platform: "mobile",
    redirectUris: [],
    scopes: ["openid", "profile", "api:read", "api:write", "offline_access"],
    supportsOfflineAccess: true,
  },
] as const satisfies readonly OAuthStaticClient[]

export const enabledOAuthClients = oauthClients.filter(
  (client) => client.enabled,
)

export const enabledOAuthClientIds = new Set(
  enabledOAuthClients.map((client) => client.clientId),
)

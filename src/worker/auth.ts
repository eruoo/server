import { apiKey } from "@better-auth/api-key"
import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth"
import { APIError, betterAuth } from "better-auth"
import { jwt } from "better-auth/plugins"

import {
  API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS,
  API_KEY_DEFAULT_PERMISSIONS,
} from "../shared/api-key"
import {
  enabledOAuthClientIds,
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
  oauthScopes,
  OAUTH_RESOURCE,
} from "../shared/oauth"
import { createResolvedInstanceGetter } from "./auth/initialized-instance-cache"
import { OAUTH_ACCESS_TOKEN_JWKS_OPTIONS } from "./auth/oauth-access-token"
import type { AuthEnv } from "./config"
import { getRuntimeConfig } from "./config"

const days = (value: number) => value * 24 * 60 * 60

interface AuthenticationSource {
  method: string
  oauth?:
    | {
        profile?: Record<string, unknown> | undefined
        providerId: string
      }
    | undefined
}

export function isOwnerAuthenticationSource(
  source: AuthenticationSource,
  ownerGitHubId: string,
): boolean {
  const profileId = source.oauth?.profile?.["id"]

  return (
    source.method === "oauth" &&
    source.oauth?.providerId === "github" &&
    (typeof profileId === "number" || typeof profileId === "string") &&
    String(profileId) === ownerGitHubId
  )
}

function assertUserVerified(userVerified: boolean | undefined): void {
  if (userVerified !== true) {
    throw new APIError("UNAUTHORIZED", {
      code: "USER_VERIFICATION_REQUIRED",
      message: "The authenticator must verify the user.",
    })
  }
}

function createApiKeyPlugin() {
  return apiKey({
    apiKeyHeaders: "x-api-key",
    configId: "default",
    defaultPrefix: "eruoo_",
    deferUpdates: false,
    disableKeyHashing: false,
    enableSessionForAPIKeys: false,
    keyExpiration: {
      defaultExpiresIn: days(180),
      disableCustomExpiresTime: false,
      maxExpiresIn: 365,
      minExpiresIn: 1,
    },
    permissions: {
      defaultPermissions: {
        status: [...API_KEY_DEFAULT_PERMISSIONS.status],
      },
    },
    rateLimit: {
      enabled: true,
      maxRequests: API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
      timeWindow: API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS * 1_000,
    },
    requireName: true,
    storage: "database",
  })
}

function createPluginTuple<const Plugins extends BetterAuthPlugin[]>(
  ...plugins: Plugins
): Plugins {
  return plugins
}

type OAuthProviderPlugin = ReturnType<typeof oauthProvider>
type BetterAuthEndpoint = NonNullable<BetterAuthPlugin["endpoints"]>[string]
type CompatibleOAuthProviderPlugin = Omit<OAuthProviderPlugin, "endpoints"> & {
  endpoints: {
    [
      Key in keyof OAuthProviderPlugin["endpoints"]
    ]: OAuthProviderPlugin["endpoints"][Key] & BetterAuthEndpoint
  }
}

export interface AuthConformanceOptions {
  /**
   * Test-only, server-side policy override. This must never be derived from a
   * request, client metadata, or a runtime environment binding.
   */
  oauthAccessTokenSigningAlgorithm: "RS256"
}

function createOAuthProviderPlugin(
  conformance?: AuthConformanceOptions,
): CompatibleOAuthProviderPlugin {
  const usesIsolatedResourcePolicy = conformance !== undefined
  const plugin = oauthProvider({
    accessTokenExpiresIn: 60 * 60,
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    cachedResources: usesIsolatedResourcePolicy
      ? new Set<string>()
      : new Set([OAUTH_RESOURCE]),
    cachedTrustedClients: enabledOAuthClientIds,
    clientPrivileges: () => false,
    consentPage: "/oauth/consent",
    enforcePerClientResources: true,
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: "/login",
    refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
    refreshTokenReuseInterval: 30,
    resourcePrivileges: () => false,
    resourceSeedMode: usesIsolatedResourcePolicy ? "overwrite" : "insertOnly",
    resources: [
      {
        accessTokenTtl: 60 * 60,
        allowedScopes: [...oauthScopes],
        identifier: OAUTH_RESOURCE,
        name: "eruoo API",
        refreshTokenTtl: OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
        signingAlgorithm:
          conformance?.oauthAccessTokenSigningAlgorithm ?? "EdDSA",
      },
    ],
    scopes: [...oauthScopes],
    storeTokens: "hashed",
  })

  // @ts-expect-error -- oauth-provider 1.7.0 publishes an OpenAPI parameter
  // declaration narrower than Better Auth 1.7.0 accepts under TypeScript 6.
  // Runtime and peer versions are aligned; preserve the plugin's exact API.
  return plugin
}

export type AuthDatabase = NonNullable<BetterAuthOptions["database"]>
type ValidateUserInfo = NonNullable<
  NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
>

export type WorkerAuthEnv = AuthEnv & Pick<Env, "AUDIT_IP_HASH_SECRET" | "DB">

export function createAuthOptions(
  env: AuthEnv,
  database: AuthDatabase,
  conformance?: AuthConformanceOptions,
) {
  const config = getRuntimeConfig(env)

  return {
    appName: "eruoo",
    basePath: "/api/auth",
    baseURL: config.appOrigin,
    database,
    disabledPaths: [
      "/account-info",
      "/change-email",
      "/change-password",
      "/delete-user",
      "/delete-user/callback",
      "/get-access-token",
      "/link-social",
      "/list-accounts",
      "/list-sessions",
      "/ok",
      "/refresh-token",
      "/request-password-reset",
      "/reset-password",
      "/revoke-other-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/send-verification-email",
      "/sign-in/email",
      "/sign-up/email",
      "/unlink-account",
      "/update-session",
      "/update-user",
      "/verify-email",
      "/verify-password",
    ],
    secrets: config.betterAuthSecrets,
    trustedOrigins: [config.appOrigin],
    emailAndPassword: {
      enabled: false,
    },
    onAPIError: {
      errorURL: `${config.appOrigin}/login`,
    },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        redirectURI: `${config.appOrigin}/api/auth/callback/github`,
      },
    },
    user: {
      validateUserInfo: (({ source }) => {
        if (!isOwnerAuthenticationSource(source, config.ownerGitHubId)) {
          return {
            error: "owner_not_allowed",
            errorDescription: "This account is not allowed to sign in.",
          }
        }
      }) satisfies ValidateUserInfo,
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 30,
        // JWE 对称加密存储 Session 快照：内容不可解码，仅凭 secret 可读。
        // 默认 compact 只是 HMAC 防篡改，与规格文档“加密 cookie”不符。
        strategy: "jwe",
      },
      disableSessionRefresh: true,
      expiresIn: days(30),
      freshAge: 0,
      additionalFields: {
        reauthenticatedAt: {
          defaultValue: () => new Date(),
          input: false,
          required: true,
          type: "date",
        },
      },
    },
    rateLimit: {
      customRules: {
        "/get-session": false,
      },
      enabled: true,
      storage: "database",
    },
    advanced: {
      database: {
        joins: true,
      },
      cookiePrefix: "eruoo",
      crossSubDomainCookies: {
        enabled: false,
      },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.appOriginUrl.protocol === "https:",
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      trustedProxyHeaders: false,
      useSecureCookies: config.appOriginUrl.protocol === "https:",
    },
    plugins: createPluginTuple(
      jwt({
        disableSettingJwtHeader: true,
        jwks: OAUTH_ACCESS_TOKEN_JWKS_OPTIONS,
        jwt: {
          issuer: config.appOrigin,
        },
      }),
      passkey({
        rpID: config.passkeyRpId,
        rpName: "eruoo",
        origin: config.appOrigin,
        authenticatorSelection: {
          userVerification: "required",
        },
        registration: {
          requireSession: true,
          afterVerification: ({ verification }) => {
            assertUserVerified(verification.registrationInfo?.userVerified)
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            assertUserVerified(verification.authenticationInfo.userVerified)
          },
        },
      }),
      createApiKeyPlugin(),
      createOAuthProviderPlugin(conformance),
    ),
  } satisfies BetterAuthOptions
}

function instantiateAuth(env: WorkerAuthEnv) {
  return betterAuth(createAuthOptions(env, env.DB))
}

export type Auth = ReturnType<typeof instantiateAuth>

function instantiateApiKeyVerifier(env: WorkerAuthEnv) {
  const config = getRuntimeConfig(env)

  return betterAuth({
    basePath: "/api/auth",
    baseURL: config.appOrigin,
    database: env.DB,
    plugins: [createApiKeyPlugin()],
    secrets: config.betterAuthSecrets,
  })
}

export type ApiKeyVerifier = ReturnType<typeof instantiateApiKeyVerifier>

export function createAuth(env: WorkerAuthEnv): Auth {
  return instantiateAuth(env)
}

export function createApiKeyVerifier(env: WorkerAuthEnv): ApiKeyVerifier {
  return instantiateApiKeyVerifier(env)
}

export const getInitializedAuth = createResolvedInstanceGetter(instantiateAuth)
export const getInitializedApiKeyVerifier = createResolvedInstanceGetter(
  instantiateApiKeyVerifier,
)

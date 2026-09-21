import { apiKey } from "@better-auth/api-key"
import { oauthProvider } from "@better-auth/oauth-provider"
import { passkey } from "@better-auth/passkey"
import { betterAuth } from "better-auth"
import type { BetterAuthOptions } from "better-auth"
import { APIError } from "better-auth/api"
import { jwt } from "better-auth/plugins"

import {
  API_KEY_AI_CONFIG_ID,
  API_KEY_AI_OPERATIONS,
  API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS,
  API_KEY_DEFAULT_CONFIG_ID,
  API_KEY_DEFAULT_PERMISSIONS,
} from "../shared/api-key"
import {
  enabledOAuthClientIds,
  oauthScopes,
  OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
} from "../shared/oauth"
import { boundedGitHubTransport } from "./auth/github-transport"
import {
  AUTH_BASE_PATH,
  AUTH_RATE_LIMIT_MAX_REQUESTS,
  AUTH_RATE_LIMIT_WINDOW_SECONDS,
} from "./auth/persistent-rate-limit"
import { OAUTH_ACCESS_TOKEN_JWKS_OPTIONS } from "./oauth/access-token"
import { persistSigningKey } from "./oauth/signing-keys"

const DAYS_IN_SECONDS = 24 * 60 * 60

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

/**
 * 单人 owner 端点收敛:关闭全部内置多用户/密码/邮箱端点。
 * 仅保留 GitHub OAuth 流程与 session 生命周期端点。
 */
const disabledPaths = [
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
] as const

export interface WorkerAuthConfig {
  appOrigin: string
  betterAuthSecrets: string
  githubClientId: string
  githubClientSecret: string
  ownerGitHubId: string
  onSigningKeyCreated?: (key: { id: string; alg?: string }) => void
  onSessionCreated?: (session: { id: string; userId: string }) => void
}

interface VersionedSecret {
  version: number
  value: string
}

/**
 * 解析 BETTER_AUTH_SECRETS("<version>:<secret>,<version>:<secret>...")
 * 为 Better Auth 的轮换格式。value 至少 32 字符(与旧工程校验一致,
 * 防止弱密钥进入轮换链)。
 */
function parseVersionedSecrets(rawSecrets: string): VersionedSecret[] {
  const versions = new Set<number>()
  return rawSecrets.split(",").map((rawEntry) => {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(":")
    const version = Number(
      separator > 0 ? entry.slice(0, separator) : Number.NaN,
    )

    if (!Number.isInteger(version) || version < 0 || versions.has(version)) {
      throw new Error("BETTER_AUTH_SECRETS entries must use <version>:<secret>")
    }

    const value = entry.slice(separator + 1)
    if (value.length < 32) {
      throw new Error(
        "BETTER_AUTH_SECRETS values must be at least 32 characters",
      )
    }

    versions.add(version)
    return { version, value }
  })
}

export function createAuthOptions(
  config: WorkerAuthConfig,
  database: D1Database,
) {
  const origin = new URL(config.appOrigin)
  if (
    origin.origin !== config.appOrigin ||
    !["http:", "https:"].includes(origin.protocol) ||
    !/^\d+$/.test(config.ownerGitHubId) ||
    !config.githubClientId ||
    !config.githubClientSecret
  ) {
    throw new Error("Invalid authentication configuration")
  }
  return {
    appName: "eruoo",
    basePath: AUTH_BASE_PATH,
    baseURL: config.appOrigin,
    database,
    logger: { disabled: true },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            config.onSessionCreated?.(session)
          },
          before: async (session) => {
            const owner = await database
              .prepare(
                "SELECT 1 FROM account WHERE userId=? AND providerId='github' AND accountId=? LIMIT 1",
              )
              .bind(session.userId, config.ownerGitHubId)
              .first()
            return owner ? { data: session } : false
          },
        },
      },
    },
    disabledPaths: [...disabledPaths],
    secrets: parseVersionedSecrets(config.betterAuthSecrets),
    trustedOrigins: [config.appOrigin],
    emailAndPassword: {
      enabled: false,
    },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        redirectURI: `${config.appOrigin}/api/auth/callback/github`,
      },
    },
    user: {
      validateUserInfo: ({ source }) => {
        if (!isOwnerAuthenticationSource(source, config.ownerGitHubId)) {
          return {
            error: "owner_not_allowed",
            errorDescription: "This account is not allowed to sign in.",
          }
        }
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 30,
        // JWE 对称加密(非默认 HMAC compact):cookie 内容仅凭 secret 可读。
        strategy: "jwe",
        refreshCache: false,
      },
      disableSessionRefresh: false,
      deferSessionRefresh: false,
      updateAge: DAYS_IN_SECONDS,
      expiresIn: 30 * DAYS_IN_SECONDS,
      freshAge: 0,
      additionalFields: {
        // §7:敏感操作 15 分钟重认证窗口的锚点字段。
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
      window: AUTH_RATE_LIMIT_WINDOW_SECONDS,
      max: AUTH_RATE_LIMIT_MAX_REQUESTS,
    },
    advanced: {
      database: {
        joins: true,
      },
      cookiePrefix: "eruoo",
      trustedProxyHeaders: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      boundedGitHubTransport(),
      jwt({
        adapter: {
          createJwk: async (data) => {
            const { key, created } = await persistSigningKey(database, data)
            if (created) config.onSigningKeyCreated?.(key)
            return key
          },
        },
        disableSettingJwtHeader: true,
        jwks: OAUTH_ACCESS_TOKEN_JWKS_OPTIONS,
        jwt: { issuer: config.appOrigin },
      }),
      oauthProvider({
        accessTokenExpiresIn: 3600,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        cachedTrustedClients: enabledOAuthClientIds,
        cachedResources: new Set<string>(),
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        enforcePerClientResources: true,
        grantTypes: ["authorization_code", "refresh_token"],
        loginPage: "/login",
        consentPage: "/oauth/consent",
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_MAX_TTL_SECONDS,
        refreshTokenReuseInterval: 30,
        scopes: [...oauthScopes],
        storeTokens: "hashed",
      }),
      // Two application profiles share one plugin: `default` (status) and
      // `ai` (invocation). The plugin resolves an unknown configId to the
      // default profile, so every profile the gateway accepts must be
      // declared here; the gateway rejects anything else before it reaches
      // the plugin. AI model grants are per key and built server-side.
      apiKey([
        {
          apiKeyHeaders: "x-api-key",
          configId: API_KEY_DEFAULT_CONFIG_ID,
          defaultPrefix: "eruoo_",
          deferUpdates: false,
          disableKeyHashing: false,
          enableSessionForAPIKeys: false,
          keyExpiration: {
            defaultExpiresIn: 180 * DAYS_IN_SECONDS,
            disableCustomExpiresTime: false,
            minExpiresIn: 1,
            maxExpiresIn: 365,
          },
          permissions: { defaultPermissions: API_KEY_DEFAULT_PERMISSIONS },
          rateLimit: {
            enabled: true,
            maxRequests: API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
            timeWindow: API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS * 1_000,
          },
          requireName: true,
          storage: "database",
        },
        {
          apiKeyHeaders: "x-api-key",
          configId: API_KEY_AI_CONFIG_ID,
          defaultPrefix: "eruoo_",
          deferUpdates: false,
          disableKeyHashing: false,
          enableSessionForAPIKeys: false,
          keyExpiration: {
            defaultExpiresIn: 180 * DAYS_IN_SECONDS,
            disableCustomExpiresTime: false,
            minExpiresIn: 1,
            maxExpiresIn: 365,
          },
          permissions: {
            defaultPermissions: { ai: [...API_KEY_AI_OPERATIONS] },
          },
          rateLimit: {
            enabled: true,
            maxRequests: API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS,
            timeWindow: API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS * 1_000,
          },
          requireName: true,
          storage: "database",
        },
      ]),
      passkey({
        rpID: origin.hostname,
        rpName: "eruoo",
        origin: config.appOrigin,
        authenticatorSelection: { userVerification: "required" },
        registration: {
          requireSession: true,
          afterVerification: ({ verification }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new APIError("FORBIDDEN", {
                message: "User verification required",
              })
          },
        },
        authentication: {
          afterVerification: ({ verification }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new APIError("FORBIDDEN", {
                message: "User verification required",
              })
          },
        },
      }),
    ],
  } satisfies BetterAuthOptions
}

export type Auth = ReturnType<typeof createAuth>

export function createAuth(config: WorkerAuthConfig, database: D1Database) {
  return betterAuth(createAuthOptions(config, database))
}

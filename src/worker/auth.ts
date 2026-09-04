import { betterAuth } from "better-auth"
import type { BetterAuthOptions } from "better-auth"

/**
 * M2 认证核心:Better Auth 1.7.2 直连 D1(无需 ORM)。
 *
 * 规范依据 docs/specs/m2-auth.md(owner 已确认):
 * - §6 硬约束:GitHub numeric ID 唯一 owner,无开放注册
 * - §7:Session 30 天固定(不滑动)、15 分钟重认证窗口、cookieCache JWE 30s
 * - Passkey/API Key/OAuth Provider 插件在 M3/M4/M5 逐个叠加
 *
 * ALS patch 退役验证(见 redesign-assets.md §2):Better Auth 1.7.2 已上游修复
 * workerd async context loss(#10855),本文件无 patch 依赖。
 */

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
  return rawSecrets.split(",").map((rawEntry) => {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(":")
    const version = Number(
      separator > 0 ? entry.slice(0, separator) : Number.NaN,
    )

    if (!Number.isInteger(version) || version < 0) {
      throw new Error("BETTER_AUTH_SECRETS entries must use <version>:<secret>")
    }

    const value = entry.slice(separator + 1)
    if (value.length < 32) {
      throw new Error(
        "BETTER_AUTH_SECRETS values must be at least 32 characters",
      )
    }

    return { version, value }
  })
}

export function createAuthOptions(
  config: WorkerAuthConfig,
  database: D1Database,
): BetterAuthOptions {
  return {
    appName: "eruoo",
    basePath: "/api/auth",
    baseURL: config.appOrigin,
    database,
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
      // §7:30 天固定(不滑动),到期重新 GitHub OAuth。
      cookieCache: {
        enabled: true,
        maxAge: 30,
        // JWE 对称加密(非默认 HMAC compact):cookie 内容仅凭 secret 可读。
        strategy: "jwe",
      },
      disableSessionRefresh: true,
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
    },
    advanced: {
      database: {
        joins: true,
      },
      cookiePrefix: "eruoo",
    },
  } satisfies BetterAuthOptions
}

export type Auth = ReturnType<typeof betterAuth>

export function createAuth(
  config: WorkerAuthConfig,
  database: D1Database,
): Auth {
  return betterAuth(createAuthOptions(config, database))
}

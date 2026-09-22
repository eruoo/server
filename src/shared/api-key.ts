export const API_KEY_EXPIRATION_HEADER = "API-Key-Expires-At"
export const API_KEY_EXPIRATION_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000

/**
 * 每把 key 的插件侧限流（Better Auth apiKey 插件配置的唯一事实源，
 * 由 auth.ts 引用）。入口粗限流不在此维护：wrangler.jsonc 的 ratelimits
 * 与发布脚本校验才是 5 次/60 秒入口限流的事实源。
 */
export const API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS = 60
export const API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS = 60

/** default 档（status 用途）的固定权限，由 auth.ts 插件配置引用。 */
export const API_KEY_DEFAULT_PERMISSIONS = {
  status: ["read"],
} as const

/**
 * 应用侧 API Key 配置档。default 用于 status；ai 用于推理调用，权限
 * 由服务端按 owner 选择的连接与原生模型 ID 构造，不依赖插件回退。
 */
export const API_KEY_DEFAULT_CONFIG_ID = "default"
/** 创建请求的用途选择器；省略或 status 映射到 default 档。 */
export const API_KEY_STATUS_PURPOSE = "status"
/** 创建请求的用途选择器；ai 映射到 ai 档并强制携带 connectionId 和 modelIds。 */
export const API_KEY_AI_PURPOSE = "ai"
export const API_KEY_AI_CONFIG_ID = "ai"

/**
 * AI 档固定授予的 operation。模型许可另存于所选单条连接的
 * `ai-model:<连接 UUID>:<权限版本>` action 集合；两项检查必须同时通过。
 */
export const API_KEY_AI_OPERATIONS = ["invoke", "models:read"] as const

export const API_KEY_AI_MODEL_PERMISSION_PREFIX = "ai-model:"

/** 持久权限键：绑定不可复用的连接 UUID，不依赖连接名称。 */
export function apiKeyAiModelPermissionKey(
  connectionId: string,
  permissionVersion = 0,
): string {
  return `${API_KEY_AI_MODEL_PERMISSION_PREFIX}${connectionId}:${permissionVersion}`
}

/** A caller key chooses exactly one connection, even when its model list is empty. */
export interface AiKeyConnectionGrant {
  connectionId: string
  permissionVersion: number
  modelIds: string[]
}

export function readAiKeyConnectionGrant(
  permissions: Readonly<Record<string, readonly string[]>> | null | undefined,
): AiKeyConnectionGrant | null {
  const scopes = Object.entries(permissions ?? {}).filter(([scope]) =>
    scope.startsWith(API_KEY_AI_MODEL_PERMISSION_PREFIX),
  )
  // Legacy multi-connection keys must be explicitly rebound, never routed arbitrarily.
  if (scopes.length !== 1) return null
  const [scope, models] = scopes[0]!
  const [connectionId, rawVersion] = scope
    .slice(API_KEY_AI_MODEL_PERMISSION_PREFIX.length)
    .split(":")
  const permissionVersion = Number(rawVersion)
  if (
    !connectionId ||
    !Number.isSafeInteger(permissionVersion) ||
    permissionVersion < 0 ||
    scope !== apiKeyAiModelPermissionKey(connectionId, permissionVersion) ||
    !Array.isArray(models) ||
    !models.every((model) => typeof model === "string")
  )
    return null
  return { connectionId, permissionVersion, modelIds: [...models] }
}

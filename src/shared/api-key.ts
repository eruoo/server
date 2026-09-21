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
 * 由服务端按 owner 选择的对外模型 ID 构造，不依赖插件回退。
 */
export const API_KEY_DEFAULT_CONFIG_ID = "default"
/** 创建请求的用途选择器；省略或 status 映射到 default 档。 */
export const API_KEY_STATUS_PURPOSE = "status"
/** 创建请求的用途选择器；ai 映射到 ai 档并强制携带 modelIds。 */
export const API_KEY_AI_PURPOSE = "ai"
export const API_KEY_AI_CONFIG_ID = "ai"

/**
 * AI 档固定授予的 operation。模型许可另存于每个连接的
 * `ai-model:<连接 UUID>` action 集合；两项检查必须同时通过。
 */
export const API_KEY_AI_OPERATIONS = ["invoke", "models:read"] as const

export const API_KEY_AI_MODEL_PERMISSION_PREFIX = "ai-model:"

/** 持久权限键：绑定不可复用的连接 UUID，而不是可复用的 slug。 */
export function apiKeyAiModelPermissionKey(connectionId: string): string {
  return `${API_KEY_AI_MODEL_PERMISSION_PREFIX}${connectionId}`
}

/** 对外模型 ID：连接 slug 与上游模型 ID 以第一个斜杠分隔。 */
export function formatAiExternalModelId(
  connectionSlug: string,
  upstreamModelId: string,
): string {
  return `${connectionSlug}/${upstreamModelId}`
}

export interface AiExternalModelIdParts {
  connectionSlug: string
  upstreamModelId: string
}

/**
 * Splits an external model ID at its first slash. The remainder keeps the
 * upstream ID exactly as stored: no case folding, trimming, or URL decoding.
 * A leading, trailing, or missing slash is not a model ID.
 */
export function parseAiExternalModelId(
  value: string,
): AiExternalModelIdParts | null {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return null
  return {
    connectionSlug: value.slice(0, separator),
    upstreamModelId: value.slice(separator + 1),
  }
}

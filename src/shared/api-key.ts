export const API_KEY_EXPIRATION_HEADER = "API-Key-Expires-At"
export const API_KEY_EXPIRATION_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000
export const API_KEY_CREDENTIAL_RATE_LIMIT_MAX_REQUESTS = 60
export const API_KEY_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS = 60
export const API_KEY_STATUS_INGRESS_RATE_LIMIT_MAX_REQUESTS = 5
export const API_KEY_STATUS_INGRESS_RATE_LIMIT_WINDOW_SECONDS = 60

export const API_KEY_STATUS_PERMISSION = "status:read"
export const API_KEY_DEFAULT_PERMISSIONS = {
  status: ["read"],
} as const

/**
 * 应用侧 API Key 配置档。当前只开放 default（status 用途）；
 * AI 档由后续切片引入，网关在此之前拒绝未知档，不依赖插件回退。
 */
export const API_KEY_DEFAULT_CONFIG_ID = "default"
/** 创建请求的用途选择器；省略或 status 映射到 default 档。 */
export const API_KEY_STATUS_PURPOSE = "status"

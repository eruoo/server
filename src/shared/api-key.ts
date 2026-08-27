export const API_KEY_EXPIRATION_HEADER = "API-Key-Expires-At"
export const API_KEY_EXPIRATION_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000

export const API_KEY_STATUS_PERMISSION = "status:read"
export const API_KEY_DEFAULT_PERMISSIONS = {
  status: ["read"],
} as const

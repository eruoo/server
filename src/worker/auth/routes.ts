export const authOperations = new Map<
  string,
  { read: boolean; limited: boolean; owner?: "recent" | "session" }
>([
  [
    "POST /api/auth/api-key/create",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "POST /api/auth/api-key/update",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "POST /api/auth/api-key/delete",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "GET /api/auth/api-key/list",
    { read: true, limited: false, owner: "session" },
  ],
  [
    "GET /api/auth/api-key/get",
    { read: true, limited: false, owner: "session" },
  ],
  ["POST /api/auth/sign-in/social", { read: false, limited: true }],
  ["GET /api/auth/callback/github", { read: false, limited: true }],
  ["GET /api/auth/get-session", { read: true, limited: false }],
  ["POST /api/auth/sign-out", { read: false, limited: true }],
  [
    "GET /api/auth/passkey/generate-authenticate-options",
    { read: false, limited: true },
  ],
  [
    "POST /api/auth/passkey/verify-authentication",
    { read: false, limited: true },
  ],
  [
    "GET /api/auth/passkey/list-user-passkeys",
    { read: true, limited: false, owner: "session" },
  ],
  [
    "GET /api/auth/passkey/generate-register-options",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "POST /api/auth/passkey/verify-registration",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "POST /api/auth/passkey/update-passkey",
    { read: false, limited: true, owner: "recent" },
  ],
  [
    "POST /api/auth/passkey/delete-passkey",
    { read: false, limited: true, owner: "recent" },
  ],
])

export const loginErrors = new Set([
  "owner_not_allowed",
  "state_not_found",
  "state_mismatch",
  "invalid_code",
  "access_denied",
  "unable_to_get_user_info",
  "invalid_signature",
  "service_unavailable",
])

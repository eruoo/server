import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"

import { deadlineFetch } from "./http"

export const authClient = createAuthClient({
  disableDefaultFetchPlugins: true,
  plugins: [passkeyClient(), oauthProviderClient()],
  fetchOptions: { customFetchImpl: deadlineFetch, retry: 0 },
})
export type SessionData = typeof authClient.$Infer.Session

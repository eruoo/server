import { apiKeyClient } from "@better-auth/api-key/client"
import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/vue"

const AUTH_REQUEST_TIMEOUT_MS = 30_000

function fetchWithAuthRequestTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  // The signal must remain attached after headers arrive so that stalled
  // response-body reads are covered by both cancellation boundaries.
  return fetch(input, { ...init, signal })
}

export const authClient = createAuthClient({
  fetchOptions: {
    // Better Auth supplies its own signal for Session reads, which causes the
    // dependency's timeout option to be skipped. Enforce both boundaries here.
    customFetchImpl: fetchWithAuthRequestTimeout,
  },
  plugins: [oauthProviderClient(), passkeyClient(), apiKeyClient()],
})

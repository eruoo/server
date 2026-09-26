import type { Auth } from "../auth"
import type { OAuthGrantFailure } from "../oauth/authorization-code"
export interface OwnerSession {
  subject: string
  sessionId: string
  reauthenticatedAt?: number
}
export type AppBindings = {
  Bindings: Env
  Variables: {
    oauthRefreshFamilyRevocationManaged?: boolean
    oauthGrantFailure?: OAuthGrantFailure
    sessionRead?: "weak" | "strong"
    requestId: string
    responseCookies: string[]
    auth: Auth | undefined
    principal: OwnerSession | undefined
    /**
     * Profile and grant facts of the api-key mutation that just answered, so
     * the audit event carries the §7 metadata (configId, change count)
     * without the scheduler re-parsing the request or response.
     */
    apiKeyAudit?: { configId: string; modelGrantCount: number }
  }
}

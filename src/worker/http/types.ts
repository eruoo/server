import type { Auth } from "../auth"
export interface OwnerSession {
  subject: string
  sessionId: string
  reauthenticatedAt?: number
}
export type AppBindings = {
  Bindings: Env
  Variables: {
    oauthRefreshFamilyRevocationManaged?: boolean
    sessionRead?: "weak" | "strong"
    requestId: string
    responseCookies: string[]
    auth: Auth | undefined
    principal: OwnerSession | undefined
  }
}

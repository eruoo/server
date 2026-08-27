import type { Principal } from "../../shared/principal"

export interface AppBindings {
  Bindings: Env
  Variables: {
    oauthRefreshFamilyRevocationManaged?: boolean
    principal: Principal
    requestId: string
  }
}

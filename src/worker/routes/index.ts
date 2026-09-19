import type { OpenAPIHono } from "@hono/zod-openapi"

import { registerAiInvocationRoutes } from "../ai/invocation-routes"
import { registerApiKeyManagementContract } from "../auth/api-key-management"
import type { AppBindings } from "../http/types"
import { registerApiDocumentation } from "./api-documentation"
import { registerAuditRoute } from "./audit"
import { registerBackupStatusRoute } from "./backup-status"
import { registerOAuthAuthorizations } from "./oauth-authorizations"
import { registerStatusRoute } from "./status"
export function registerApplicationRoutes(app: OpenAPIHono<AppBindings>) {
  registerAuditRoute(app)
  registerStatusRoute(app)
  registerBackupStatusRoute(app)
  registerOAuthAuthorizations(app)
  registerApiKeyManagementContract(app)
  registerAiInvocationRoutes(app)
  registerApiDocumentation(app)
}

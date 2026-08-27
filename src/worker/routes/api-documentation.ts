import { Scalar } from "@scalar/hono-api-reference"
import { Hono } from "hono"
import { NONCE, secureHeaders } from "hono/secure-headers"

import { SCALAR_STANDALONE_ASSET_PATH } from "../../shared/scalar"
import { requireOwnerSession } from "../auth/session"
import type { AppBindings } from "../http/types"
import type { OpenApiDocument } from "../openapi"

const scalarContentSecurityPolicy = secureHeaders({
  contentSecurityPolicy: {
    baseUri: ["'none'"],
    connectSrc: ["'self'"],
    defaultSrc: ["'none'"],
    fontSrc: ["'self'"],
    formAction: ["'none'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", "data:"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'", NONCE],
    styleSrc: ["'self'", "'unsafe-inline'"],
    workerSrc: ["'none'"],
  },
})

const scalarReference = Scalar<AppBindings>((context) => {
  const nonce = context.get("secureHeadersNonce")
  if (!nonce) {
    throw new Error("Scalar CSP nonce is unavailable.")
  }

  return {
    agent: { disabled: true },
    cdn: SCALAR_STANDALONE_ASSET_PATH,
    hideTestRequestButton: true,
    nonce,
    pageTitle: "eruoo API Reference",
    persistAuth: false,
    telemetry: false,
    url: "/api/openapi.json",
    withDefaultFonts: false,
  }
})

export function createApiDocumentationRouter(
  createDocument: () => OpenApiDocument,
) {
  const router = new Hono<AppBindings>({ strict: true })

  router.use("/api/docs", requireOwnerSession)
  router.use("/api/openapi.json", requireOwnerSession)
  router.use("/api/docs", scalarContentSecurityPolicy)
  router.use("/api/docs", async (context, next) => {
    await next()
    context.header("Cache-Control", "private, no-store")
  })

  router.get("/api/docs", scalarReference)
  router.get("/api/openapi.json", (context) =>
    context.json(createDocument(), 200, {
      "Cache-Control": "private, no-store",
    }),
  )

  return router
}

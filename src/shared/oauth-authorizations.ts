import { z } from "@hono/zod-openapi"

import { oauthClients, oauthScopes, OAUTH_RESOURCE } from "./oauth"
const oauthClientIdSchema = z.enum(
  oauthClients.map((client) => client.clientId),
)
const oauthPlatformSchema = z.enum(
  oauthClients.map((client) => client.platform),
)

const oauthAuthorizationSchema = z
  .object({
    activeRefreshTokenCount: z.int().nonnegative(),
    authorized: z.boolean(),
    clientId: oauthClientIdSchema,
    consentCount: z.int().nonnegative(),
    enabled: z.boolean(),
    lastAuthorizedAt: z.int().nonnegative().nullable().openapi({
      description:
        "Most recent authorization activity as Unix epoch milliseconds, or null when the application is not authorized.",
      format: "int64",
    }),
    name: z.string().min(1),
    offlineAccess: z.boolean(),
    platform: oauthPlatformSchema,
    resources: z.array(z.literal(OAUTH_RESOURCE)),
    scopes: z.array(z.enum(oauthScopes)),
    supportsOfflineAccess: z.boolean(),
  })
  .strict()
  .openapi("OAuthAuthorization")

export const oauthAuthorizationListSchema = z.array(oauthAuthorizationSchema)

export const revokeOAuthAuthorizationSchema = z
  .object({
    clientId: oauthClientIdSchema,
    deletedConsentCount: z.int().nonnegative(),
    revokedRefreshTokenCount: z.int().nonnegative(),
  })
  .strict()
  .openapi("OAuthAuthorizationRevocation")

-- Policy source: src/shared/oauth.ts. The upsert also permits forward migration
-- after restoring an older snapshot whose credential scrub already seeded Hako.
INSERT INTO "oauthClient" (
  "id", "clientId", "clientSecret", "clientDiscoveryId", "disabled",
  "skipConsent", "enableEndSession", "subjectType", "scopes",
  "clientCredentialsScopes", "userId", "createdAt", "updatedAt", "name",
  "redirectUris", "postLogoutRedirectUris", "backchannelLogoutUri",
  "backchannelLogoutSessionRequired", "tokenEndpointAuthMethod",
  "applicationType", "jwks", "jwksUri", "grantTypes", "responseTypes",
  "requirePKCE", "dpopBoundAccessTokens", "metadata"
) VALUES (
  'static-hako-web', 'hako-web', NULL, NULL, 0,
  1, 0, 'public', '["openid","profile"]',
  NULL, NULL, 0, 0, 'Hako',
  '["https://hako.eruoo.me/api/auth/callback"]', NULL, NULL,
  NULL, 'none', 'web', NULL, NULL, '["authorization_code"]', '["code"]',
  1, 0, '{"managedBy":"migration"}'
)
ON CONFLICT("clientId") DO UPDATE SET
  "clientSecret"=excluded."clientSecret",
  "clientDiscoveryId"=excluded."clientDiscoveryId",
  "disabled"=excluded."disabled",
  "skipConsent"=excluded."skipConsent",
  "enableEndSession"=excluded."enableEndSession",
  "subjectType"=excluded."subjectType",
  "scopes"=excluded."scopes",
  "clientCredentialsScopes"=excluded."clientCredentialsScopes",
  "userId"=excluded."userId",
  "name"=excluded."name",
  "redirectUris"=excluded."redirectUris",
  "postLogoutRedirectUris"=excluded."postLogoutRedirectUris",
  "backchannelLogoutUri"=excluded."backchannelLogoutUri",
  "backchannelLogoutSessionRequired"=excluded."backchannelLogoutSessionRequired",
  "tokenEndpointAuthMethod"=excluded."tokenEndpointAuthMethod",
  "applicationType"=excluded."applicationType",
  "jwks"=excluded."jwks",
  "jwksUri"=excluded."jwksUri",
  "grantTypes"=excluded."grantTypes",
  "responseTypes"=excluded."responseTypes",
  "requirePKCE"=excluded."requirePKCE",
  "dpopBoundAccessTokens"=excluded."dpopBoundAccessTokens";

DELETE FROM "oauthClientResource" WHERE "clientId"='hako-web';
INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "metadata", "createdAt")
VALUES ('static-hako-web-api', 'hako-web', 'https://auth.eruoo.me/api', '{"managedBy":"migration"}', 0);

-- Better Auth 1.7.0 schema, generated from src/worker/auth.ts.
CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "reauthenticatedAt" DATE NOT NULL
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "jwks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  "expiresAt" DATE,
  "alg" TEXT,
  "crv" TEXT
);

CREATE TABLE "passkey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT,
  "publicKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" TEXT NOT NULL,
  "counter" INTEGER NOT NULL,
  "deviceType" TEXT NOT NULL,
  "backedUp" INTEGER NOT NULL,
  "transports" TEXT,
  "createdAt" DATE,
  "aaguid" TEXT
);

CREATE TABLE "apikey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "configId" TEXT NOT NULL,
  "name" TEXT,
  "start" TEXT,
  "referenceId" TEXT NOT NULL,
  "prefix" TEXT,
  "key" TEXT NOT NULL,
  "refillInterval" INTEGER,
  "refillAmount" INTEGER,
  "lastRefillAt" DATE,
  "enabled" INTEGER,
  "rateLimitEnabled" INTEGER,
  "rateLimitTimeWindow" INTEGER,
  "rateLimitMax" INTEGER,
  "requestCount" INTEGER,
  "remaining" INTEGER,
  "lastRequest" DATE,
  "expiresAt" DATE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "permissions" TEXT,
  "metadata" TEXT
);

CREATE TABLE "oauthClient" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL UNIQUE,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" INTEGER,
  "skipConsent" INTEGER,
  "enableEndSession" INTEGER,
  "subjectType" TEXT,
  "scopes" TEXT,
  "clientCredentialsScopes" TEXT,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" DATE,
  "updatedAt" DATE,
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT NOT NULL,
  "postLogoutRedirectUris" TEXT,
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" INTEGER,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" TEXT,
  "responseTypes" TEXT,
  "requirePKCE" INTEGER,
  "dpopBoundAccessTokens" INTEGER,
  "referenceId" TEXT,
  "metadata" TEXT
);

CREATE TABLE "oauthResource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT,
  "customClaims" TEXT,
  "dpopBoundAccessTokensRequired" INTEGER,
  "disabled" INTEGER,
  "createdAt" DATE,
  "updatedAt" DATE,
  "policyVersion" INTEGER,
  "metadata" TEXT
);

CREATE TABLE "oauthClientResource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" TEXT,
  "createdAt" DATE
);

CREATE TABLE "oauthRefreshToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "revoked" DATE,
  "rotatedAt" DATE,
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" DATE,
  "authTime" DATE,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "refreshId" TEXT REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "revoked" DATE,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

-- Owner revocation is durable per authorization-code token family. Refresh
-- rotation copies authorizationCodeId to every successor, so this tombstone
-- remains effective even when a successor insert races the owner DELETE batch.
CREATE TABLE "oauthRefreshTokenFamilyRevocation" (
  "authorizationCodeId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "revokedAt" DATE NOT NULL,
  PRIMARY KEY ("authorizationCodeId", "clientId", "userId")
);

CREATE INDEX "oauthRefreshTokenFamilyRevocation_userId_clientId_idx"
  ON "oauthRefreshTokenFamilyRevocation" ("userId", "clientId");
CREATE INDEX "oauthRefreshTokenFamilyRevocation_revokedAt_idx"
  ON "oauthRefreshTokenFamilyRevocation" ("revokedAt");

CREATE TABLE "oauthClientAssertion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL
);

CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

-- Serializes maintenance jobs whose external side effects cannot participate
-- in a D1 transaction, such as checking an R2 budget before a backup upload.
CREATE TABLE "maintenance_lease" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL
);

-- Persists the latest terminal result of the database backup Workflow. The
-- singleton survives Worker restarts and is safe to query from the owner UI.
CREATE TABLE "database_backup_health" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "startedAt" INTEGER NOT NULL,
  "completedAt" INTEGER NOT NULL,
  "lastSuccessAt" INTEGER,
  "failureCode" TEXT,
  CONSTRAINT "database_backup_health_name_check"
    CHECK ("name" = 'database-backup'),
  CONSTRAINT "database_backup_health_status_check"
    CHECK ("status" IN ('failed', 'ok')),
  CONSTRAINT "database_backup_health_time_check"
    CHECK (
      "startedAt" BETWEEN 0 AND 8640000000000000
      AND "completedAt" BETWEEN "startedAt" AND 8640000000000000
      AND (
        "lastSuccessAt" IS NULL
        OR "lastSuccessAt" BETWEEN 0 AND 8640000000000000
      )
    ),
  CONSTRAINT "database_backup_health_terminal_check"
    CHECK (
      (
        "status" = 'ok'
        AND "failureCode" IS NULL
        AND "lastSuccessAt" IS NOT NULL
      )
      OR ("status" = 'failed' AND "failureCode" IS NOT NULL)
    )
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX "verification_expiresAt_idx" ON "verification" ("expiresAt");
CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");
CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");
CREATE INDEX "oauthClientResource_clientId_idx"
  ON "oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx"
  ON "oauthClientResource" ("resourceId");
CREATE INDEX "oauthRefreshToken_clientId_idx"
  ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx"
  ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx"
  ON "oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx"
  ON "oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX "oauthRefreshToken_rotationReplayExpiresAt_idx"
  ON "oauthRefreshToken" ("rotationReplayExpiresAt");
CREATE INDEX "oauthRefreshToken_expiresAt_idx"
  ON "oauthRefreshToken" ("expiresAt");
CREATE INDEX "oauthRefreshToken_family_expiresAt_idx"
  ON "oauthRefreshToken" (
    "authorizationCodeId",
    "clientId",
    "userId",
    "expiresAt"
  );
CREATE INDEX "oauthAccessToken_clientId_idx"
  ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx"
  ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx"
  ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx"
  ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx"
  ON "oauthAccessToken" ("refreshId");
CREATE INDEX "oauthAccessToken_expiresAt_idx"
  ON "oauthAccessToken" ("expiresAt");
CREATE INDEX "oauthConsent_clientId_idx"
  ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx"
  ON "oauthConsent" ("userId");
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" (
  "issuer",
  "accountId"
);
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx"
  ON "oauthClientResource" ("clientId", "resourceId");

-- Static OAuth resources and clients are deployment-owned. Only enabled entries
-- from src/shared/oauth.ts are inserted; reserved disabled IDs stay absent.
INSERT INTO "oauthResource" (
  "id",
  "identifier",
  "name",
  "accessTokenTtl",
  "refreshTokenTtl",
  "signingAlgorithm",
  "allowedScopes",
  "dpopBoundAccessTokensRequired",
  "disabled",
  "createdAt",
  "updatedAt",
  "policyVersion",
  "metadata"
) VALUES (
  'static-eruoo-api',
  'https://auth.eruoo.me/api',
  'eruoo API',
  3600,
  2592000,
  'EdDSA',
  '["openid","profile","api:read","api:write","offline_access"]',
  0,
  0,
  0,
  0,
  1,
  '{"managedBy":"migration"}'
);

INSERT INTO "oauthClient" (
  "id",
  "clientId",
  "disabled",
  "skipConsent",
  "enableEndSession",
  "subjectType",
  "scopes",
  "createdAt",
  "updatedAt",
  "name",
  "redirectUris",
  "tokenEndpointAuthMethod",
  "applicationType",
  "grantTypes",
  "responseTypes",
  "requirePKCE",
  "dpopBoundAccessTokens",
  "metadata"
) VALUES (
  'static-eruoo-desktop',
  'eruoo-desktop',
  0,
  1,
  1,
  'public',
  '["openid","profile","api:read","api:write","offline_access"]',
  0,
  0,
  'eruoo Desktop',
  '["http://127.0.0.1/oauth/callback","http://[::1]/oauth/callback"]',
  'none',
  'native',
  '["authorization_code","refresh_token"]',
  '["code"]',
  1,
  0,
  '{"managedBy":"migration"}'
);

INSERT INTO "oauthClientResource" (
  "id",
  "clientId",
  "resourceId",
  "metadata",
  "createdAt"
) VALUES (
  'static-eruoo-desktop-api',
  'eruoo-desktop',
  'https://auth.eruoo.me/api',
  '{"managedBy":"migration"}',
  0
);

CREATE TABLE "security_audit_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "type" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "occurredAt" INTEGER NOT NULL,
  "subjectId" TEXT,
  "credentialId" TEXT,
  "clientId" TEXT,
  "ipFingerprint" TEXT,
  "requestId" TEXT NOT NULL,
  "metadata" TEXT
);

CREATE INDEX "security_audit_events_occurredAt_id_idx"
  ON "security_audit_events" ("occurredAt" DESC, "id" DESC);
CREATE INDEX "security_audit_events_outcome_occurredAt_id_idx"
  ON "security_audit_events" ("outcome", "occurredAt" DESC, "id" DESC);
CREATE INDEX "security_audit_events_type_occurredAt_id_idx"
  ON "security_audit_events" ("type", "occurredAt" DESC, "id" DESC);
CREATE INDEX "security_audit_events_type_outcome_occurredAt_id_idx"
  ON "security_audit_events" (
    "type",
    "outcome",
    "occurredAt" DESC,
    "id" DESC
  );

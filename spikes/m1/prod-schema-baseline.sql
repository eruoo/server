-- 生产 D1(eruoo-server)schema 结构基线
-- 采集:2026-09-04 14:4x UTC,只读查询 sqlite_master
-- 用途:M1 D4 门禁——新 migrations/0001 应用到验证 D1 后,与此基线逐对象比对
-- 说明:type 排序 table 在前;此文件是证据快照,不作为 migration 源执行

-- [table] account
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

-- [table] apikey
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

-- [table] d1_migrations
CREATE TABLE "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- [table] database_backup_health
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

-- [table] jwks
CREATE TABLE "jwks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "publicKey" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  "expiresAt" DATE,
  "alg" TEXT,
  "crv" TEXT
);

-- [table] maintenance_lease
CREATE TABLE "maintenance_lease" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL
);

-- [table] oauthAccessToken
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

-- [table] oauthClient
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

-- [table] oauthClientAssertion
CREATE TABLE "oauthClientAssertion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL
);

-- [table] oauthClientResource
CREATE TABLE "oauthClientResource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" TEXT,
  "createdAt" DATE
);

-- [table] oauthConsent
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

-- [table] oauthRefreshToken
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

-- [table] oauthRefreshTokenFamilyRevocation
CREATE TABLE "oauthRefreshTokenFamilyRevocation" (
  "authorizationCodeId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "revokedAt" DATE NOT NULL,
  PRIMARY KEY ("authorizationCodeId", "clientId", "userId")
);

-- [table] oauthResource
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

-- [table] passkey
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

-- [table] rateLimit
CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL,
  "lastRequest" BIGINT NOT NULL
);

-- [table] security_audit_events
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

-- [table] session
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

-- [table] user
CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

-- [table] verification
CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

-- [index] account_issuer_accountId_uidx
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" (
  "issuer",
  "accountId"
);

-- [index] account_userId_idx
CREATE INDEX "account_userId_idx" ON "account" ("userId");

-- [index] apikey_configId_idx
CREATE INDEX "apikey_configId_idx" ON "apikey" ("configId");

-- [index] apikey_key_idx
CREATE INDEX "apikey_key_idx" ON "apikey" ("key");

-- [index] apikey_referenceId_idx
CREATE INDEX "apikey_referenceId_idx" ON "apikey" ("referenceId");

-- [index] oauthAccessToken_authorizationCodeId_idx
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx"
  ON "oauthAccessToken" ("authorizationCodeId");

-- [index] oauthAccessToken_clientId_idx
CREATE INDEX "oauthAccessToken_clientId_idx"
  ON "oauthAccessToken" ("clientId");

-- [index] oauthAccessToken_expiresAt_idx
CREATE INDEX "oauthAccessToken_expiresAt_idx"
  ON "oauthAccessToken" ("expiresAt");

-- [index] oauthAccessToken_refreshId_idx
CREATE INDEX "oauthAccessToken_refreshId_idx"
  ON "oauthAccessToken" ("refreshId");

-- [index] oauthAccessToken_sessionId_idx
CREATE INDEX "oauthAccessToken_sessionId_idx"
  ON "oauthAccessToken" ("sessionId");

-- [index] oauthAccessToken_userId_idx
CREATE INDEX "oauthAccessToken_userId_idx"
  ON "oauthAccessToken" ("userId");

-- [index] oauthClientResource_clientId_idx
CREATE INDEX "oauthClientResource_clientId_idx"
  ON "oauthClientResource" ("clientId");

-- [index] oauthClientResource_clientId_resourceId_uidx
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx"
  ON "oauthClientResource" ("clientId", "resourceId");

-- [index] oauthClientResource_resourceId_idx
CREATE INDEX "oauthClientResource_resourceId_idx"
  ON "oauthClientResource" ("resourceId");

-- [index] oauthClient_userId_idx
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

-- [index] oauthConsent_clientId_idx
CREATE INDEX "oauthConsent_clientId_idx"
  ON "oauthConsent" ("clientId");

-- [index] oauthConsent_userId_idx
CREATE INDEX "oauthConsent_userId_idx"
  ON "oauthConsent" ("userId");

-- [index] oauthRefreshTokenFamilyRevocation_revokedAt_idx
CREATE INDEX "oauthRefreshTokenFamilyRevocation_revokedAt_idx"
  ON "oauthRefreshTokenFamilyRevocation" ("revokedAt");

-- [index] oauthRefreshTokenFamilyRevocation_userId_clientId_idx
CREATE INDEX "oauthRefreshTokenFamilyRevocation_userId_clientId_idx"
  ON "oauthRefreshTokenFamilyRevocation" ("userId", "clientId");

-- [index] oauthRefreshToken_authorizationCodeId_idx
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx"
  ON "oauthRefreshToken" ("authorizationCodeId");

-- [index] oauthRefreshToken_clientId_idx
CREATE INDEX "oauthRefreshToken_clientId_idx"
  ON "oauthRefreshToken" ("clientId");

-- [index] oauthRefreshToken_expiresAt_idx
CREATE INDEX "oauthRefreshToken_expiresAt_idx"
  ON "oauthRefreshToken" ("expiresAt");

-- [index] oauthRefreshToken_family_expiresAt_idx
CREATE INDEX "oauthRefreshToken_family_expiresAt_idx"
  ON "oauthRefreshToken" (
    "authorizationCodeId",
    "clientId",
    "userId",
    "expiresAt"
  );

-- [index] oauthRefreshToken_rotationReplayExpiresAt_idx
CREATE INDEX "oauthRefreshToken_rotationReplayExpiresAt_idx"
  ON "oauthRefreshToken" ("rotationReplayExpiresAt");

-- [index] oauthRefreshToken_sessionId_idx
CREATE INDEX "oauthRefreshToken_sessionId_idx"
  ON "oauthRefreshToken" ("sessionId");

-- [index] oauthRefreshToken_userId_idx
CREATE INDEX "oauthRefreshToken_userId_idx"
  ON "oauthRefreshToken" ("userId");

-- [index] passkey_credentialID_idx
CREATE INDEX "passkey_credentialID_idx" ON "passkey" ("credentialID");

-- [index] passkey_userId_idx
CREATE INDEX "passkey_userId_idx" ON "passkey" ("userId");

-- [index] security_audit_events_occurredAt_id_idx
CREATE INDEX "security_audit_events_occurredAt_id_idx"
  ON "security_audit_events" ("occurredAt" DESC, "id" DESC);

-- [index] security_audit_events_outcome_occurredAt_id_idx
CREATE INDEX "security_audit_events_outcome_occurredAt_id_idx"
  ON "security_audit_events" ("outcome", "occurredAt" DESC, "id" DESC);

-- [index] security_audit_events_type_occurredAt_id_idx
CREATE INDEX "security_audit_events_type_occurredAt_id_idx"
  ON "security_audit_events" ("type", "occurredAt" DESC, "id" DESC);

-- [index] security_audit_events_type_outcome_occurredAt_id_idx
CREATE INDEX "security_audit_events_type_outcome_occurredAt_id_idx"
  ON "security_audit_events" (
    "type",
    "outcome",
    "occurredAt" DESC,
    "id" DESC
  );

-- [index] session_userId_idx
CREATE INDEX "session_userId_idx" ON "session" ("userId");

-- [index] verification_expiresAt_idx
CREATE INDEX "verification_expiresAt_idx" ON "verification" ("expiresAt");

-- [index] verification_identifier_idx
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

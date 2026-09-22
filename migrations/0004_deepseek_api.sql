-- Owner-approved reset of the experimental AI service. Identity and non-AI
-- caller keys are preserved. No Codex state or permission is carried forward.
DELETE FROM "apikey" WHERE "configId" = 'ai';
DELETE FROM "ai_invocations";
DROP TABLE "ai_authorization_sessions";
DROP TABLE "ai_models";
DROP TABLE "ai_connections";

CREATE TABLE "ai_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "providerType" TEXT NOT NULL CHECK ("providerType" = 'deepseek'),
  "enabled" INTEGER NOT NULL,
  "authorizationStatus" TEXT NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "permissionVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("permissionVersion" >= 0),
  "credentialCiphertext" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  CONSTRAINT "ai_connections_slug_format_check"
    CHECK (
      length("slug") BETWEEN 1 AND 64
      AND "slug" NOT GLOB '*[^a-z0-9-]*'
      AND "slug" NOT GLOB '-*'
      AND "slug" NOT GLOB '*-'
      AND "slug" NOT GLOB '*--*'
    ),
  CONSTRAINT "ai_connections_enabled_check" CHECK ("enabled" IN (0, 1)),
  CONSTRAINT "ai_connections_authorization_status_check"
    CHECK (
      "authorizationStatus" IN (
        'never_authorized',
        'connected',
        'reauthentication_required'
      )
    ),
  CONSTRAINT "ai_connections_credential_presence_check"
    CHECK (
      (
        "authorizationStatus" = 'connected'
        AND "credentialCiphertext" IS NOT NULL
      )
      OR (
        "authorizationStatus" <> 'connected'
        AND "credentialCiphertext" IS NULL
      )
    ),
  CONSTRAINT "ai_connections_credential_version_check"
    CHECK ("credentialVersion" >= 0),
  CONSTRAINT "ai_connections_time_check"
    CHECK (
      "createdAt" BETWEEN 0 AND 8640000000000000
      AND "updatedAt" BETWEEN "createdAt" AND 8640000000000000
    )
);

CREATE TABLE "ai_models" (
  "connectionId" TEXT NOT NULL REFERENCES "ai_connections" ("id") ON DELETE CASCADE,
  "upstreamModelId" TEXT NOT NULL,
  "displayName" TEXT,
  "capabilities" TEXT,
  "snapshotCredentialVersion" INTEGER NOT NULL,
  "discoveredAt" INTEGER NOT NULL,
  PRIMARY KEY ("connectionId", "upstreamModelId"),
  CONSTRAINT "ai_models_version_check" CHECK ("snapshotCredentialVersion" >= 0),
  CONSTRAINT "ai_models_discoveredAt_check"
    CHECK ("discoveredAt" BETWEEN 0 AND 8640000000000000)
);

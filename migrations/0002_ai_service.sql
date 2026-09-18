-- AI service application state (docs/specs/ai-service.md §8). This slice adds
-- durable storage, bounded maintenance, and restore scrubbing only; AI HTTP
-- routes, the AI key profile, and upstream connectors open in later slices.
-- Caller credentials and permissions stay in the native API Key plugin tables.

-- One row per owner-authorized upstream connection. The UUID is server
-- generated, immutable, and never reused: recreating a deleted slug always
-- produces a new UUID, so permissions bound to the old UUID cannot be revived
-- by slug reuse. slug is immutable and unique among existing connections.
CREATE TABLE "ai_connections" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "providerType" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL,
  "authorizationStatus" TEXT NOT NULL,
  "upstreamAccountId" TEXT,
  "credentialVersion" INTEGER NOT NULL,
  "credentialCiphertext" TEXT,
  "credentialExpiresAt" INTEGER,
  "refreshClaimId" TEXT,
  "refreshClaimExpiresAt" INTEGER,
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
        AND "credentialExpiresAt" IS NOT NULL
      )
      OR (
        "authorizationStatus" <> 'connected'
        AND "credentialCiphertext" IS NULL
        AND "credentialExpiresAt" IS NULL
      )
    ),
  CONSTRAINT "ai_connections_refresh_claim_pair_check"
    CHECK (
      ("refreshClaimId" IS NULL AND "refreshClaimExpiresAt" IS NULL)
      OR ("refreshClaimId" IS NOT NULL AND "refreshClaimExpiresAt" IS NOT NULL)
    ),
  CONSTRAINT "ai_connections_credential_version_check"
    CHECK ("credentialVersion" >= 0),
  CONSTRAINT "ai_connections_time_check"
    CHECK (
      "createdAt" BETWEEN 0 AND 8640000000000000
      AND "updatedAt" BETWEEN "createdAt" AND 8640000000000000
    )
);

-- Time-limited device authorization sessions. Each session is bound to the
-- owner, the creating session, and the connection's credential version:
-- cancellation, expiry, owner-session revocation, and connection version
-- changes all block late exchange results from writing credentials.
CREATE TABLE "ai_authorization_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connectionId" TEXT NOT NULL REFERENCES "ai_connections" ("id") ON DELETE CASCADE,
  "ownerUserId" TEXT NOT NULL,
  "ownerSessionId" TEXT NOT NULL,
  "connectionCredentialVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "deviceGrantCiphertext" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "nextPollAt" INTEGER NOT NULL,
  "pollClaimId" TEXT,
  "pollClaimExpiresAt" INTEGER,
  "completionId" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  CONSTRAINT "ai_authorization_sessions_status_check"
    CHECK ("status" IN ('pending', 'completed', 'cancelled')),
  CONSTRAINT "ai_authorization_sessions_completion_check"
    CHECK (
      ("status" = 'completed' AND "completionId" IS NOT NULL)
      OR ("status" <> 'completed' AND "completionId" IS NULL)
    ),
  CONSTRAINT "ai_authorization_sessions_poll_claim_pair_check"
    CHECK (
      ("pollClaimId" IS NULL AND "pollClaimExpiresAt" IS NULL)
      OR ("pollClaimId" IS NOT NULL AND "pollClaimExpiresAt" IS NOT NULL)
    ),
  CONSTRAINT "ai_authorization_sessions_version_check"
    CHECK ("connectionCredentialVersion" >= 0),
  CONSTRAINT "ai_authorization_sessions_time_check"
    CHECK (
      "createdAt" BETWEEN 0 AND 8640000000000000
      AND "updatedAt" BETWEEN "createdAt" AND 8640000000000000
      AND "expiresAt" > "createdAt"
      AND "nextPollAt" >= "createdAt"
    )
);

CREATE INDEX "ai_authorization_sessions_connectionId_idx"
  ON "ai_authorization_sessions" ("connectionId");
CREATE INDEX "ai_authorization_sessions_expiresAt_idx"
  ON "ai_authorization_sessions" ("expiresAt");

-- Model catalog snapshots per connection. The upstream model ID is stored
-- exactly as reported: no case folding, trimming, or extra URL decoding. A
-- snapshot row never implies the connection is currently authorized or the
-- model is usable; usability additionally requires the connection's current
-- credential version to match the snapshot version.
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

-- Invocation admission and terminal metadata. Key, connection, and model are
-- identifier snapshots with no foreign keys: deleting a connection or key
-- never cascades invocation history. A reserved row whose lease has expired
-- without a terminal record is read as unknown; missing usage stays unknown
-- instead of being reported as zero.
CREATE TABLE "ai_invocations" (
  "requestId" TEXT NOT NULL PRIMARY KEY,
  "apiKeyId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "upstreamModelId" TEXT NOT NULL,
  "startedAt" INTEGER NOT NULL,
  "deadlineAt" INTEGER NOT NULL,
  "leaseExpiresAt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "endedAt" INTEGER,
  "errorCode" TEXT,
  "upstreamRequestId" TEXT,
  "usage" TEXT,
  CONSTRAINT "ai_invocations_status_check"
    CHECK (
      "status" IN ('reserved', 'succeeded', 'failed', 'incomplete', 'unknown')
    ),
  CONSTRAINT "ai_invocations_terminal_ended_check"
    CHECK (
      ("status" = 'reserved' AND "endedAt" IS NULL)
      OR ("status" <> 'reserved' AND "endedAt" IS NOT NULL)
    ),
  CONSTRAINT "ai_invocations_time_check"
    CHECK (
      "startedAt" BETWEEN 0 AND 8640000000000000
      AND "deadlineAt" > "startedAt"
      AND "leaseExpiresAt" >= "deadlineAt"
      AND ("endedAt" IS NULL OR "endedAt" >= "startedAt")
    )
);

CREATE INDEX "ai_invocations_startedAt_requestId_idx"
  ON "ai_invocations" ("startedAt" DESC, "requestId" DESC);
CREATE INDEX "ai_invocations_inflight_lease_idx"
  ON "ai_invocations" ("leaseExpiresAt") WHERE "status" = 'reserved';
CREATE INDEX "ai_invocations_inflight_apiKey_lease_idx"
  ON "ai_invocations" ("apiKeyId", "leaseExpiresAt") WHERE "status" = 'reserved';

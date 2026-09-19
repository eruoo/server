-- Invocation admission takes its slot before the request body is read, so the
-- connection and upstream model are not known yet when the reservation is
-- written. Both identity columns become nullable and are filled in by the
-- conditional identity assignment once the model is resolved and authorized;
-- NULL is the explicit "not yet known" representation, never a fabricated
-- identifier, and a terminal row written by the transport always carries its
-- identity. Columns, checks, indexes and retention semantics are unchanged.
--
-- SQLite cannot drop a NOT NULL constraint in place, so the table is rebuilt
-- and its rows are copied verbatim before the old table is dropped.
ALTER TABLE "ai_invocations" RENAME TO "ai_invocations_previous";

CREATE TABLE "ai_invocations" (
  "requestId" TEXT NOT NULL PRIMARY KEY,
  "apiKeyId" TEXT NOT NULL,
  "connectionId" TEXT,
  "upstreamModelId" TEXT,
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

INSERT INTO "ai_invocations" (
  "requestId", "apiKeyId", "connectionId", "upstreamModelId",
  "startedAt", "deadlineAt", "leaseExpiresAt", "status",
  "endedAt", "errorCode", "upstreamRequestId", "usage"
)
SELECT
  "requestId", "apiKeyId", "connectionId", "upstreamModelId",
  "startedAt", "deadlineAt", "leaseExpiresAt", "status",
  "endedAt", "errorCode", "upstreamRequestId", "usage"
FROM "ai_invocations_previous";

DROP TABLE "ai_invocations_previous";

CREATE INDEX "ai_invocations_startedAt_requestId_idx"
  ON "ai_invocations" ("startedAt" DESC, "requestId" DESC);
CREATE INDEX "ai_invocations_inflight_lease_idx"
  ON "ai_invocations" ("leaseExpiresAt") WHERE "status" = 'reserved';
CREATE INDEX "ai_invocations_inflight_apiKey_lease_idx"
  ON "ai_invocations" ("apiKeyId", "leaseExpiresAt") WHERE "status" = 'reserved';

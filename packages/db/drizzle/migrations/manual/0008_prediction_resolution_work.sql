-- Apply before enabling the Phase 0 prediction recovery worker.
-- Pending proof drafts stay in this internal table until settlement commits.
CREATE TABLE IF NOT EXISTS "PredictionResolutionWork" (
  "questionId" text PRIMARY KEY REFERENCES "Question" ("id") ON DELETE CASCADE,
  "resolutionDate" timestamp NOT NULL,
  "outcome" boolean NOT NULL,
  "nextAttemptAt" timestamptz,
  "draft" jsonb
);

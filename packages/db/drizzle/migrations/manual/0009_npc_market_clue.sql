-- Apply before enabling market clue publication on this database.
CREATE TABLE IF NOT EXISTS "NpcMarketClue" (
  "questionId" text NOT NULL REFERENCES "Question"("id") ON DELETE CASCADE,
  "phase" text NOT NULL,
  "postId" text REFERENCES "Post"("id") ON DELETE SET NULL,
  PRIMARY KEY ("questionId", "phase")
);

CREATE INDEX IF NOT EXISTS "NpcMarketClue_postId_idx" ON "NpcMarketClue" ("postId");

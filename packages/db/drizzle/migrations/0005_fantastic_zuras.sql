-- NOTE: TradingFee.idempotencyKey is added here, but its unique index is
-- NOT created by this migration. TradingFee is a populated table and a
-- plain CREATE UNIQUE INDEX inside Drizzle's transactional migration would
-- block writes. The index is created concurrently, outside any transaction,
-- by packages/db/scripts/apply-trading-fee-idempotency-index.ts
-- (bun run --cwd packages/db db:apply-trading-fee-idempotency-index),
-- which must run after this migration. The index definition matches the
-- uniqueIndex declared in packages/db/src/schema/trading.ts, so the
-- post-migration schema state still matches this snapshot. See AGENTS.md
-- "Production database".
ALTER TABLE "TradingFeeOutbox" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "TradingFee" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
CREATE UNIQUE INDEX "TradingFeeOutbox_idempotencyKey_idx" ON "TradingFeeOutbox" USING btree ("idempotencyKey");

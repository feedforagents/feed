ALTER TABLE "TradingFeeOutbox" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "TradingFee" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
CREATE UNIQUE INDEX "TradingFeeOutbox_idempotencyKey_idx" ON "TradingFeeOutbox" USING btree ("idempotencyKey");--> statement-breakpoint
CREATE UNIQUE INDEX "TradingFee_idempotencyKey_idx" ON "TradingFee" USING btree ("idempotencyKey");
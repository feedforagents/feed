CREATE TABLE "PredictionTradeIdempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"marketId" text NOT NULL,
	"operation" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" json NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "PredictionTradeIdempotency_userId_key_idx" ON "PredictionTradeIdempotency" USING btree ("userId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "PredictionTradeIdempotency_userId_createdAt_idx" ON "PredictionTradeIdempotency" USING btree ("userId","createdAt");
CREATE TABLE "PredictionTrade" (
	"id" text PRIMARY KEY NOT NULL,
	"marketId" text NOT NULL,
	"userId" text NOT NULL,
	"side" boolean NOT NULL,
	"action" text NOT NULL,
	"shares" numeric(18, 6) NOT NULL,
	"price" numeric(18, 6) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "PredictionTrade_marketId_idx" ON "PredictionTrade" USING btree ("marketId");--> statement-breakpoint
CREATE INDEX "PredictionTrade_marketId_createdAt_idx" ON "PredictionTrade" USING btree ("marketId","createdAt");
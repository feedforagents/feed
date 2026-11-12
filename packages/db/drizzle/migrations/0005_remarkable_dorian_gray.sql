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
CREATE INDEX "PredictionTrade_marketId_createdAt_idx" ON "PredictionTrade" USING btree ("marketId","createdAt");--> statement-breakpoint
-- Backfill PredictionTrade from the wallet ledger (BalanceTransaction).
-- Before this table existed, every user prediction trade wrote exactly one
-- BalanceTransaction row (WalletService.debit 'pred_buy' on buy,
-- WalletService.credit 'pred_sell' on sell) with the market id in
-- relatedId. Without this backfill the widget reads Vol 0 for every
-- market until new trades arrive, because the new table starts empty.
-- The backfill is approximate: the ledger records the settled cash
-- amount (a buy is gross, fee included; a sell is net proceeds, fee
-- excluded) while a live trade records shares x avgPrice, fee
-- excluded; and the ledger records neither side nor shares/price, so
-- backfilled rows carry shares = amount and price = 1 (so amount =
-- shares x price still holds) and the side parsed from the ledger
-- description ('Buy YES ...' / 'Sell NO ...') when it matches, YES
-- otherwise. NPC trades have no BalanceTransaction rows and are not
-- covered. Rows are keyed 'backfill-<ledger id>' and the insert is
-- ON CONFLICT DO NOTHING, so re-running it never duplicates a row.
INSERT INTO "PredictionTrade" ("id", "marketId", "userId", "side", "action", "shares", "price", "amount", "createdAt")
SELECT
	'backfill-' || bt."id",
	bt."relatedId",
	bt."userId",
	CASE
		WHEN bt."description" LIKE 'Buy YES %' OR bt."description" LIKE 'Sell YES %' THEN true
		WHEN bt."description" LIKE 'Buy NO %' OR bt."description" LIKE 'Sell NO %' THEN false
		ELSE true
	END,
	CASE WHEN bt."type" = 'pred_buy' THEN 'buy' ELSE 'sell' END,
	bt."amount",
	1,
	bt."amount",
	bt."createdAt"
FROM "BalanceTransaction" bt
WHERE bt."type" IN ('pred_buy', 'pred_sell')
	AND bt."relatedId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
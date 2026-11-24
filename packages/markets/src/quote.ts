// spec/markets/prediction.md, "Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact"
import { buySharesBought } from "../gen/markets__prediction.ts";
import { canonicalTradingFeeAtBps } from "../gen/shared__money.ts";

export interface PredictionBuyQuoteInput {
  readonly yesShares: number;
  readonly noShares: number;
  readonly side: "yes" | "no";
  readonly amountCents: number;
  readonly feeBps: number;
}

export function estimatePredictionBuyShares(input: PredictionBuyQuoteInput): number {
  if (input.yesShares <= 0 || input.noShares <= 0 || input.amountCents <= 0) return 0;
  const netCents = input.amountCents - canonicalTradingFeeAtBps(input.amountCents, input.feeBps);
  if (netCents <= 0) return 0;
  return buySharesBought(input.yesShares, input.noShares, input.side === "yes" ? "Yes" : "No", netCents);
}

import type { ComponentMeta } from "vibestack/stories";
import type { MarketCardProps } from "./MarketCard.tsx";

const predictionMarket = {
  kind: "prediction" as const,
  id: "mkt-15m-1",
  question: "Will OpenAI parody NPC ship a model leak in the 15m slot?",
  timeframe: "15m",
  phase: "Trading" as const,
  yesOddsPct: 64,
  liquidityPts: "1,420 pts",
  closesIn: "9m left",
};

const perpMarket = {
  kind: "perp" as const,
  id: "perp-sam",
  ticker: "SAMALT",
  name: "Sam Parody Index Perpetual",
  indexPricePts: "102.40 pts",
  markPricePts: "103.15 pts",
  fundingRatePct: "+0.04%",
  openInterestPts: "18,900 pts",
  change24hPct: 8.4,
  maxLeverage: 20,
};

export const meta: ComponentMeta<MarketCardProps> = {
  args: { market: predictionMarket },
  examples: {
    ManualHold: { market: { ...predictionMarket, phase: "ManualReviewHold", closesIn: "Closed" } },
    Perp: { market: perpMarket },
  },
};

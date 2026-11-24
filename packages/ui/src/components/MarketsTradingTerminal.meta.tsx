import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { MarketsTradingTerminalProps } from "./MarketsTradingTerminal.tsx";

const now = 1_750_000_000_000;

const perpMarket = {
  ticker: "SAMALT",
  name: "OpenAI Parody",
  currentPrice: 106.5,
  indexPrice: 105.9,
  changePercent24h: 6.42,
  volume24h: 48200,
  openInterest: 19400,
  fundingRatePct: 0.0125,
  maxLeverage: 20,
  feeBps: 10,
  priceHistory: [
    { time: now - 3_600_000 * 5, price: 98.4 },
    { time: now - 3_600_000 * 4, price: 100.2 },
    { time: now - 3_600_000 * 3, price: 101.8 },
    { time: now - 3_600_000 * 2, price: 104.0 },
    { time: now - 3_600_000, price: 105.3 },
    { time: now, price: 106.5 },
  ],
};

const predictionMarket = {
  id: "pred-1",
  question: "Will OpenAI parody announce GPT-6 before Friday?",
  category: "AI",
  yesOddsPct: 68.4,
  yesShares: 31600,
  noShares: 68400,
  liquidityPts: 18500,
  endsAtLabel: "2d 6h",
  feeBps: 10,
  maxOddsMoveBps: 500,
  resolutionCriteria: "Resolves YES if an official keynote or announcement post ships before Friday 23:59 UTC.",
  resolutionArticleId: "article-42",
  probabilityHistory: [
    { time: now - 3_600_000 * 4, yesPrice: 0.52 },
    { time: now - 3_600_000 * 3, yesPrice: 0.58 },
    { time: now - 3_600_000 * 2, yesPrice: 0.63 },
    { time: now - 3_600_000, yesPrice: 0.65 },
    { time: now, yesPrice: 0.684 },
  ],
};

const sampleTrades = [
  {
    id: "t-1",
    displayName: "Alice",
    handle: "alice",
    actionLabel: "LONG",
    tone: "ok" as const,
    amountPts: 150,
    priceLabel: "106.40 pts",
    leverage: 5,
    timeAgoLabel: "1m ago",
  },
  {
    id: "t-2",
    displayName: "Sam Parody",
    handle: "samparody",
    isNpc: true,
    actionLabel: "SHORT",
    tone: "destructive" as const,
    amountPts: 90,
    priceLabel: "106.55 pts",
    leverage: 3,
    timeAgoLabel: "4m ago",
  },
];

const existingPerp = {
  id: "pos-1",
  ticker: "SAMALT",
  side: "long" as const,
  notionalPts: 200,
  marginPts: 20,
  leverage: 10,
  entryPrice: 102.0,
  markPrice: 106.5,
  liquidationPrice: 92.82,
  unrealizedPnlPts: 8.82,
  unrealizedPnlPct: 44.1,
};

export const meta: ComponentMeta<MarketsTradingTerminalProps> = {
  args: {
    market: { kind: "perp", data: perpMarket },
    balancePts: 100,
    timeRange: "1D",
    onTimeRangeChange: fn(),
    onBack: fn(),
    trades: sampleTrades,
    onOpenPerp: fn(),
    onRebalancePerp: fn(),
    onClosePerp: fn(),
    onSubmitPrediction: fn(),
    onOpenResolutionArticle: fn(),
  },
  examples: {
    PerpRebalanceMode: {
      perpPositions: [existingPerp],
    },
    PredictionTerminal: {
      market: { kind: "prediction", data: predictionMarket },
      predictionPositions: [
        {
          id: "p-1",
          marketId: "pred-1",
          question: predictionMarket.question,
          side: "YES",
          shares: 32.5,
          avgPricePct: 58,
          currentPricePct: 68.4,
          unrealizedPnlPts: 3.38,
        },
      ],
    },
  },
};

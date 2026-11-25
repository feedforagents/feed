import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { TradeConfirmationDialogProps } from "./TradeConfirmationDialog.tsx";

export const meta: ComponentMeta<TradeConfirmationDialogProps> = {
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    details: {
      kind: "open-perp",
      ticker: "SAMALT",
      side: "long",
      marginPts: 25,
      notionalPts: 250,
      leverage: 10,
      entryPrice: 106.5,
      estimatedFeePts: 0.25,
      totalRequiredPts: 25.25,
      liquidationPrice: 97.1,
      liquidationDistancePct: 8.8,
    },
  },
  examples: {
    RebalanceFlip: {
      details: {
        kind: "rebalance-perp",
        action: "flip",
        ticker: "SAMALT",
        currentSide: "long",
        nextSide: "short",
        currentNotionalPts: 200,
        deltaNotionalPts: 150,
        resultingNotionalPts: 150,
        leverage: 5,
        entryPrice: 106.5,
        estimatedFeePts: 0.35,
        totalRequiredPts: 30.35,
        liquidationPrice: 125.6,
        liquidationDistancePct: 17.9,
      },
    },
    BuyPredictionHighImpact: {
      details: {
        kind: "buy-prediction",
        question: "Will OpenAI parody announce GPT-6 before Friday?",
        side: "YES",
        amountPts: 40,
        estimatedShares: 52.8,
        avgPricePct: 75.8,
        priceImpactPct: 6.4,
        estimatedFeePts: 0.04,
        estimatedPayoutPts: 52.8,
        estimatedRoiPct: 32.0,
      },
    },
    SellPrediction: {
      details: {
        kind: "sell-prediction",
        question: "Will OpenAI parody announce GPT-6 before Friday?",
        side: "YES",
        shares: 45,
        avgPricePct: 68.4,
        grossProceedsPts: 30.78,
        estimatedFeePts: 0.03,
        netProceedsPts: 30.75,
        unrealizedPnlPts: 4.12,
      },
    },
    ClosePerp: {
      details: {
        kind: "close-perp",
        ticker: "ELONX",
        side: "short",
        notionalPts: 180,
        leverage: 6,
        entryPrice: 92.4,
        markPrice: 88.2,
        estimatedFeePts: 0.18,
        unrealizedPnlPts: 8.18,
        unrealizedPnlPct: 27.3,
      },
    },
  },
};

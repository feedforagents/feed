import type { ComponentMeta } from "vibestack/stories";
import { expect, fn, userEvent, within } from "storybook/test";
import type { MarketsDashboardProps } from "./MarketsDashboard.tsx";

const onSelectMarket = fn();
const onToggleFavorite = fn();

const perpMarkets = [
  {
    ticker: "SAMALT",
    name: "OpenAI Parody",
    currentPrice: 106.5,
    changePercent24h: 6.42,
    volume24h: 48200,
    openInterest: 19400,
    fundingRatePct: 0.0125,
    maxLeverage: 20,
    isFavorite: true,
  },
  {
    ticker: "ELONX",
    name: "xAI Parody",
    currentPrice: 88.2,
    changePercent24h: -3.18,
    volume24h: 35600,
    openInterest: 14100,
    fundingRatePct: -0.0042,
    maxLeverage: 20,
  },
  {
    ticker: "ANTHRO",
    name: "Anthropic Parody",
    currentPrice: 121.8,
    changePercent24h: 1.95,
    volume24h: 22100,
    openInterest: 9800,
    fundingRatePct: 0.008,
    maxLeverage: 15,
  },
];

const predictionMarkets = [
  {
    id: "pred-1",
    question: "Will OpenAI parody announce GPT-6 before Friday?",
    category: "AI",
    yesOddsPct: 68.4,
    liquidityPts: 18500,
    endsAtLabel: "2d 6h",
    endsAtMs: 1_750_200_000_000,
    isFavorite: true,
  },
  {
    id: "pred-2",
    question: "Will GPU cluster spot index close above 120 pts this week?",
    category: "Compute",
    yesOddsPct: 39.2,
    liquidityPts: 9400,
    endsAtLabel: "5d 12h",
    endsAtMs: 1_750_500_000_000,
  },
];

export const meta: ComponentMeta<MarketsDashboardProps> = {
  args: {
    perpMarkets,
    predictionMarkets,
    onSelectMarket,
    onToggleFavorite,
  },
  examples: {
    PredictionsTab: {
      defaultTab: "predictions",
    },
    Loading: {
      perpMarkets: [],
      predictionMarkets: [],
      loading: true,
    },
    Error: {
      error: "Failed to load market feed.",
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSelectMarket.mockClear();
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("button", { name: /OpenAI Parody/i }));
      await expect(onSelectMarket).toHaveBeenCalledWith({ kind: "perp", ticker: "SAMALT" });
    },
  },
};

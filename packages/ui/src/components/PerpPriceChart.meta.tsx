import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { PerpPriceChartProps } from "./PerpPriceChart.tsx";

const now = 1_750_000_000_000;
const rising = [
  { time: now - 3_600_000 * 6, price: 96.2 },
  { time: now - 3_600_000 * 5, price: 97.8 },
  { time: now - 3_600_000 * 4, price: 97.1 },
  { time: now - 3_600_000 * 3, price: 100.4 },
  { time: now - 3_600_000 * 2, price: 102.9 },
  { time: now - 3_600_000, price: 104.2 },
  { time: now, price: 106.5 },
];

const falling = [
  { time: now - 3_600_000 * 4, price: 112.0 },
  { time: now - 3_600_000 * 3, price: 109.4 },
  { time: now - 3_600_000 * 2, price: 105.8 },
  { time: now - 3_600_000, price: 103.2 },
  { time: now, price: 101.1 },
];

export const meta: ComponentMeta<PerpPriceChartProps> = {
  args: {
    ticker: "SAMALT",
    data: rising,
    currentPrice: 106.5,
    timeRange: "1D",
    onTimeRangeChange: fn(),
  },
  examples: {
    Falling: {
      ticker: "ELONX",
      data: falling,
      currentPrice: 101.1,
      timeRange: "4H",
    },
    Loading: {
      data: [],
      loading: true,
    },
    Empty: {
      data: [],
    },
  },
};

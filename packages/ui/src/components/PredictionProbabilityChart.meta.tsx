import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { PredictionProbabilityChartProps } from "./PredictionProbabilityChart.tsx";

const now = 1_750_000_000_000;
const curve = [
  { time: now - 3_600_000 * 5, yesPrice: 0.42 },
  { time: now - 3_600_000 * 4, yesPrice: 0.48 },
  { time: now - 3_600_000 * 3, yesPrice: 0.55 },
  { time: now - 3_600_000 * 2, yesPrice: 0.51 },
  { time: now - 3_600_000, yesPrice: 0.62 },
  { time: now, yesPrice: 0.684 },
];

export const meta: ComponentMeta<PredictionProbabilityChartProps> = {
  args: {
    marketId: "pred-1",
    data: curve,
    timeRange: "1D",
    onTimeRangeChange: fn(),
  },
  examples: {
    Loading: {
      data: [],
      loading: true,
    },
    Empty: {
      data: [],
    },
  },
};

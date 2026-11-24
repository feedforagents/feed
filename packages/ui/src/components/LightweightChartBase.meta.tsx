import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { LightweightChartBaseProps } from "./LightweightChartBase.tsx";

const now = 1_750_000_000_000;
const samplePoints = [
  { time: now - 3_600_000 * 4, value: 98.4 },
  { time: now - 3_600_000 * 3, value: 100.1 },
  { time: now - 3_600_000 * 2, value: 99.6 },
  { time: now - 3_600_000, value: 102.8 },
  { time: now, value: 104.5 },
];

export const meta: ComponentMeta<LightweightChartBaseProps> = {
  args: {
    ariaLabel: "Sample area chart",
    timeRange: "1D",
    onTimeRangeChange: fn(),
    series: [
      {
        kind: "area",
        tone: "ok",
        data: samplePoints,
        priceLine: { price: 104.5, title: "Live", tone: "brand" },
      },
    ],
  },
  examples: {
    Baseline: {
      ariaLabel: "Portfolio PnL baseline chart",
      series: [
        {
          kind: "baseline",
          baseValue: 0,
          data: [
            { time: now - 3_600_000 * 4, value: -12 },
            { time: now - 3_600_000 * 3, value: -4 },
            { time: now - 3_600_000 * 2, value: 6 },
            { time: now - 3_600_000, value: 18 },
            { time: now, value: 24.5 },
          ],
        },
      ],
    },
    Loading: {
      loading: true,
      series: [],
    },
    Empty: {
      series: [],
      emptyMessage: "No price history yet.",
    },
  },
};

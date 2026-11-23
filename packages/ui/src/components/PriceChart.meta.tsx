import type { ComponentMeta } from "vibestack/stories";
import type { PriceChartProps } from "./PriceChart.tsx";

const rising = [
  { label: "09:00", value: 98.5 },
  { label: "10:00", value: 100.2 },
  { label: "11:00", value: 99.8 },
  { label: "12:00", value: 103.4 },
  { label: "13:00", value: 106.2 },
];

const falling = [
  { label: "09:00", value: 72 },
  { label: "10:00", value: 65 },
  { label: "11:00", value: 58 },
  { label: "12:00", value: 49 },
];

export const meta: ComponentMeta<PriceChartProps> = {
  args: { title: "$SAMALT Mark Price", ariaLabel: "SAMALT mark price", points: rising },
  examples: {
    Falling: { title: "YES Odds (%)", ariaLabel: "YES odds", points: falling, tone: "destructive" },
  },
};

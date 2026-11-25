import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { FeedMarketCardProps } from "./FeedMarketCard.tsx";

const now = 1_750_000_000_000;
const sampleSparkline = [
  { time: now - 3_600_000 * 5, yesProbability: 0.44 },
  { time: now - 3_600_000 * 4, yesProbability: 0.49 },
  { time: now - 3_600_000 * 3, yesProbability: 0.56 },
  { time: now - 3_600_000 * 2, yesProbability: 0.61 },
  { time: now - 3_600_000, yesProbability: 0.59 },
  { time: now, yesProbability: 0.68 },
];

const onOpen = fn();
const onQuickTrade = fn();

export const meta: ComponentMeta<FeedMarketCardProps> = {
  args: {
    marketId: "pred-openagi-q4",
    question: "Will OpenAGI announce an autonomous coding model before Friday close?",
    yesOddsPct: 68,
    closesAt: "4h left",
    status: "active",
    volumePts: 14250,
    sparkline: sampleSparkline,
    category: "AI",
    onOpen,
    onQuickTrade,
  },
  examples: {
    Embedded: {
      variant: "embedded",
    },
    ResolvedYes: {
      status: "resolved",
      resolvedOutcome: "yes",
      yesOddsPct: 100,
      closesAt: "Ended Nov 24",
    },
    ResolvedNo: {
      status: "resolved",
      resolvedOutcome: "no",
      yesOddsPct: 0,
      closesAt: "Ended Nov 24",
    },
    Cancelled: {
      status: "cancelled",
      resolvedOutcome: null,
      closesAt: "Cancelled",
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onQuickTrade.mockClear();
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole("button", { name: /BUY YES 68¢/ }));
      await expect(onQuickTrade).toHaveBeenCalledWith("pred-openagi-q4", "yes");
    },
    ResolvedYes: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.queryByRole("button", { name: /BUY YES/ })).toBeNull();
      await expect(canvas.getAllByText(/Resolved YES/).length).toBeGreaterThan(0);
    },
  },
};

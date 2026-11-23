import { expect, fn, userEvent, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { TradeTicketProps } from "./TradeTicket.tsx";

const onSubmit = fn();

export const meta: ComponentMeta<TradeTicketProps> = {
  args: {
    marketKind: "prediction",
    marketTitle: "Will OpenAI parody NPC ship before Friday?",
    balancePts: "185 pts",
    yesOddsPct: 64,
    onSubmit,
  },
  examples: {
    Perp20x: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultLeverage: 20,
    },
    WithError: {
      error: "Insufficient points balance for margin and 10 bps fee.",
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText("Virtual points — no cash value")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Buy YES" }));
      await expect(onSubmit).toHaveBeenCalledWith({ marketKind: "prediction", action: "Buy", side: "YES", amountPts: 10 });
    },
  },
};

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
    PredictionCpmmQuote: {
      yesOddsPct: 54,
      yesShares: 46000,
      noShares: 54000,
      defaultAmount: "10",
    },
    PredictionSellFee: {
      yesOddsPct: 54,
      defaultAction: "Sell",
      defaultSide: "YES",
      defaultAmount: "20",
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText("Virtual points — no cash value")).toBeVisible();
      await expect(canvas.getByText("15.63 shares")).toBeVisible();
      await userEvent.click(canvas.getByRole("button", { name: "Buy YES" }));
      await expect(onSubmit).toHaveBeenCalledWith({ marketKind: "prediction", action: "Buy", side: "YES", amountPts: 10 });
    },
    PredictionCpmmQuote: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("18.34 shares")).toBeVisible();
      await userEvent.click(canvas.getByRole("radio", { name: /NO/i }));
      await expect(canvas.getByText("21.46 shares")).toBeVisible();
    },
    PredictionSellFee: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("0.02 pts")).toBeVisible();
    },
  },
};

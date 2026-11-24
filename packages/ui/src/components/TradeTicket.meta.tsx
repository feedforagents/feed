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
      perpPreview: {
        entryPriceCents: 10342,
        liquidationPriceCents: 9855,
        feeCents: 20,
        priceImpactBps: 26,
      },
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
      yesShares: 46000,
      noShares: 54000,
      heldYesShares: 1834,
      defaultAction: "Sell",
      defaultSide: "YES",
      defaultAmount: "18.34",
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
    Perp20x: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("103.42 pts (0.26%)")).toBeVisible();
      await expect(canvas.getByText("98.55 pts")).toBeVisible();
      await expect(canvas.getByText("0.20 pts")).toBeVisible();
    },
    PredictionCpmmQuote: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("~18.34 shares")).toBeVisible();
      await userEvent.click(canvas.getByRole("radio", { name: /NO/i }));
      await expect(canvas.getByText("~21.46 shares")).toBeVisible();
    },
    PredictionSellFee: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("Held 18.34")).toBeVisible();
      await expect(canvas.getByText("0.01 pts")).toBeVisible();
    },
  },
};

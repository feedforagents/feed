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
    PerpBelowMinimum: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultAmount: "1",
      defaultLeverage: 5,
    },
    PerpJustBelowMinimum: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultAmount: "1.99",
      defaultLeverage: 5,
    },
    PerpAtMinimum: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultAmount: "2",
      defaultLeverage: 5,
    },
    PerpJustAboveMinimum: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultAmount: "2.01",
      defaultLeverage: 5,
    },
    PerpRoundingBlocked: {
      marketKind: "perp",
      ticker: "SAMALT",
      marketTitle: "Sam Parody Index Perpetual",
      balancePts: "500 pts",
      markPricePts: "103.15 pts",
      indexPricePts: "102.40 pts",
      defaultAmount: "3.334",
      defaultLeverage: 3,
    },
  },
  play: {
    Default: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
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
    PerpBelowMinimum: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("Notional size must be at least 10 pts (margin × leverage).")).toBeVisible();
      await expect(canvas.getByRole("button", { name: "Open Long 5x" })).toBeDisabled();
    },
    PerpJustBelowMinimum: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("9.95 pts")).toBeVisible();
      await expect(canvas.getByText("Notional size must be at least 10 pts (margin × leverage).")).toBeVisible();
      await expect(canvas.getByRole("button", { name: "Open Long 5x" })).toBeDisabled();
    },
    PerpAtMinimum: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText("10 pts")).toBeVisible();
      await expect(canvas.queryByText("Notional size must be at least 10 pts (margin × leverage).")).toBeNull();
      await expect(canvas.getByRole("button", { name: "Open Long 5x" })).toBeEnabled();
      await userEvent.click(canvas.getByRole("button", { name: "Open Long 5x" }));
      await expect(onSubmit).toHaveBeenCalledWith({ marketKind: "perp", side: "Long", marginPts: 2, leverage: 5 });
    },
    PerpJustAboveMinimum: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      onSubmit.mockClear();
      const canvas = within(canvasElement);
      await expect(canvas.getByText("10.05 pts")).toBeVisible();
      await expect(canvas.queryByText("Notional size must be at least 10 pts (margin × leverage).")).toBeNull();
      await expect(canvas.getByRole("button", { name: "Open Long 5x" })).toBeEnabled();
      await userEvent.click(canvas.getByRole("button", { name: "Open Long 5x" }));
      await expect(onSubmit).toHaveBeenCalledWith({ marketKind: "perp", side: "Long", marginPts: 2.01, leverage: 5 });
    },
    PerpRoundingBlocked: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByText("9.99 pts")).toBeVisible();
      await expect(canvas.getByText("Notional size must be at least 10 pts (margin × leverage).")).toBeVisible();
      await expect(canvas.getByRole("button", { name: "Open Long 3x" })).toBeDisabled();
    },
  },
};

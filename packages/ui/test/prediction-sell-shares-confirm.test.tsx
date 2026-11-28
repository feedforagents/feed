// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { PredictionOrderInput } from "../src/components/MarketsTradingTerminal.tsx";
import { predictionPanelHarness } from "./prediction-order-panel.tsx";

const { container, renderPanel, setAmount, buttonByText, clickButton } = predictionPanelHarness();

function openSellConfirmation(yesPositionShares: number, submitted: PredictionOrderInput[]): void {
  renderPanel({ yesPositionShares }, submitted);
  clickButton("Sell");
  setAmount("15");
  clickButton("Sell YES");
}

it("blocks a sell above the held shares at entry with an insufficient-shares notice (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel({ yesPositionShares: 10 }, submitted);
  clickButton("Sell");
  setAmount("15");

  expect(container()?.textContent).toContain("Cannot sell more than your 10.00 YES shares");
  expect(buttonByText("Sell YES")?.disabled).toBe(true);
  expect(submitted).toEqual([]);
});

it("submits the confirmed sell while the held shares still cover it (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  openSellConfirmation(20, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([{ marketId: "pred-rain", action: "sell", side: "YES", amountOrShares: 15 }]);
});

it("does not submit a confirmed sell after the held shares drop below it while the confirmation is open (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  openSellConfirmation(20, submitted);

  renderPanel({ yesPositionShares: 10 }, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Cannot sell more than your 10.00 YES shares");
});

it("submits a confirmed sell when the held shares drop to exactly the sell amount while the confirmation is open (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  openSellConfirmation(20, submitted);

  renderPanel({ yesPositionShares: 15 }, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([{ marketId: "pred-rain", action: "sell", side: "YES", amountOrShares: 15 }]);
});

it("does not submit a confirmed NO sell after the held NO shares drop below it while the confirmation is open (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel({ yesPositionShares: 50, noPositionShares: 20 }, submitted);
  clickButton("Sell");
  clickButton("NO 50%");
  setAmount("15");
  clickButton("Sell NO");

  renderPanel({ yesPositionShares: 50, noPositionShares: 10 }, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Cannot sell more than your 10.00 NO shares");
});

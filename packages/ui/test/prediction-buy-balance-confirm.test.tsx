// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { PredictionOrderInput } from "../src/components/MarketsTradingTerminal.tsx";
import { predictionPanelHarness } from "./prediction-order-panel.tsx";

const { container, renderPanel, setAmount, buttonByText, clickButton } = predictionPanelHarness();

it("blocks an over-balance buy amount at entry with an insufficient-balance notice (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel({ balancePts: 100 }, submitted);
  setAmount("150");

  expect(container()?.textContent).toContain("Insufficient balance");
  expect(buttonByText("Buy YES")?.disabled).toBe(true);
  expect(submitted).toEqual([]);
});

it("submits the confirmed buy while the balance still covers the amount (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel({ balancePts: 100 }, submitted);
  setAmount("80");
  clickButton("Buy YES");
  clickButton("Confirm Trade");

  expect(submitted).toEqual([{ marketId: "pred-rain", action: "buy", side: "YES", amountOrShares: 80 }]);
});

it("does not submit a confirmed buy after the balance drops below the amount while the confirmation is open (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel({ balancePts: 100 }, submitted);
  setAmount("80");
  clickButton("Buy YES");

  renderPanel({ balancePts: 50 }, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Insufficient balance");
});

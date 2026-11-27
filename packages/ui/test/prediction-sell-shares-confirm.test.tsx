// @vitest-environment happy-dom
import { act } from "react";
import { expect, it } from "vitest";
import {
  PredictionOrderPanel,
  type PredictionOrderInput,
  type TerminalPredictionMarket,
} from "../src/components/MarketsTradingTerminal.tsx";
import { reactRootHarness } from "./react-root.ts";

const harness = reactRootHarness();
const container = () => harness.container;

const market: TerminalPredictionMarket = {
  id: "pred-rain",
  question: "Will it rain tomorrow?",
  yesOddsPct: 50,
  yesShares: 5000,
  noShares: 5000,
  liquidityPts: 10000,
  endsAtLabel: "2d 4h",
  feeBps: 10,
  maxOddsMoveBps: 2000,
  status: "active",
  probabilityHistory: [],
};

function renderPanel(yesPositionShares: number, submitted: PredictionOrderInput[], noPositionShares = 0): void {
  harness.render(
    <PredictionOrderPanel
      market={market}
      balancePts={100}
      yesPositionShares={yesPositionShares}
      noPositionShares={noPositionShares}
      onSubmitOrder={(order) => {
        submitted.push(order);
      }}
    />,
  );
}

function setAmount(value: string): void {
  const input = container()?.querySelector<HTMLInputElement>("input[type='number']");
  expect(input, "shares input").not.toBeNull();
  if (!input) return;
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
  act(() => {
    descriptor?.set?.bind(input)(value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

function clickButton(text: string): void {
  const button = buttonByText(text);
  expect(button, `button "${text}"`).toBeDefined();
  act(() => {
    button?.click();
  });
}

function openSellConfirmation(yesPositionShares: number, submitted: PredictionOrderInput[]): void {
  renderPanel(yesPositionShares, submitted);
  clickButton("Sell");
  setAmount("15");
  clickButton("Sell YES");
}

it("blocks a sell above the held shares at entry with an insufficient-shares notice (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel(10, submitted);
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

  renderPanel(10, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Cannot sell more than your 10.00 YES shares");
});

it("does not submit a confirmed NO sell after the held NO shares drop below it while the confirmation is open (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel(0, submitted, 20);
  clickButton("Sell");
  clickButton("NO 50%");
  setAmount("15");
  clickButton("Sell NO");

  renderPanel(0, submitted, 10);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Cannot sell more than your 10.00 NO shares");
});

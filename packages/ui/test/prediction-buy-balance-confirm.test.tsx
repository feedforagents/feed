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

function renderPanel(balancePts: number, submitted: PredictionOrderInput[]): void {
  harness.render(
    <PredictionOrderPanel
      market={market}
      balancePts={balancePts}
      onSubmitOrder={(order) => {
        submitted.push(order);
      }}
    />,
  );
}

function setAmount(value: string): void {
  const input = container()?.querySelector<HTMLInputElement>("input[type='number']");
  expect(input, "amount input").not.toBeNull();
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

it("blocks an over-balance buy amount at entry with an insufficient-balance notice (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel(100, submitted);
  setAmount("150");

  expect(container()?.textContent).toContain("Insufficient balance");
  expect(buttonByText("Buy YES")?.disabled).toBe(true);
  expect(submitted).toEqual([]);
});

it("submits the confirmed buy while the balance still covers the amount (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel(100, submitted);
  setAmount("80");
  clickButton("Buy YES");
  clickButton("Confirm Trade");

  expect(submitted).toEqual([{ marketId: "pred-rain", action: "buy", side: "YES", amountOrShares: 80 }]);
});

it("does not submit a confirmed buy after the balance drops below the amount while the confirmation is open (spec/markets/prediction.md, \"Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact\")", () => {
  const submitted: PredictionOrderInput[] = [];
  renderPanel(100, submitted);
  setAmount("80");
  clickButton("Buy YES");

  renderPanel(50, submitted);
  clickButton("Confirm Trade");

  expect(submitted).toEqual([]);
  expect(container()?.textContent).toContain("Insufficient balance");
});

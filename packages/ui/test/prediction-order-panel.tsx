import { act } from "react";
import { expect } from "vitest";
import {
  PredictionOrderPanel,
  type PredictionOrderInput,
  type TerminalPredictionMarket,
} from "../src/components/MarketsTradingTerminal.tsx";
import { reactRootHarness } from "./react-root.ts";

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

export interface PredictionPanelProps {
  balancePts?: number;
  yesPositionShares?: number;
  noPositionShares?: number;
}

export function predictionPanelHarness() {
  const harness = reactRootHarness();
  const container = () => harness.container;

  function renderPanel(props: PredictionPanelProps, submitted: PredictionOrderInput[]): void {
    harness.render(
      <PredictionOrderPanel
        market={market}
        balancePts={props.balancePts ?? 100}
        yesPositionShares={props.yesPositionShares}
        noPositionShares={props.noPositionShares}
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

  return { container, renderPanel, setAmount, buttonByText, clickButton };
}

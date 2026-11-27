// @vitest-environment happy-dom
import { act } from "react";
import { expect, it } from "vitest";
import { MarketsDashboard, type PredictionMarketRow } from "../src/components/MarketsDashboard.tsx";
import { reactRootHarness } from "./react-root.ts";

const harness = reactRootHarness();
const container = () => harness.container;

function predictionRow(overrides: Partial<PredictionMarketRow>): PredictionMarketRow {
  return {
    id: "pred-x",
    question: "Will the parody index close above 120 pts?",
    yesOddsPct: 55,
    liquidityPts: 10000,
    endsAtLabel: "2d 4h",
    status: "active",
    ...overrides,
  };
}

function renderDashboard(predictionMarkets: readonly PredictionMarketRow[]): void {
  harness.render(
    <MarketsDashboard
      perpMarkets={[]}
      predictionMarkets={predictionMarkets}
      defaultTab="predictions"
      onSelectMarket={() => {}}
    />,
  );
}

function clickFilter(label: string): void {
  const button = [...(container()?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `status filter "${label}"`).toBeDefined();
  act(() => {
    button?.click();
  });
}

it('an expired prediction market leaves the active list and shows an Expired badge with the closed markets (spec/markets/prediction.md, "Story: Close on schedule, review, resolve, or cancel")', () => {
  renderDashboard([
    predictionRow({ id: "pred-open", question: "Open market still trading?" }),
    predictionRow({ id: "pred-expired", question: "Market awaiting proof?", status: "expired", endsAtLabel: "0m" }),
    predictionRow({ id: "pred-resolved", question: "Resolved market settled?", status: "resolved", resolvedOutcome: "yes" }),
  ]);

  expect(container()?.textContent).toContain("Open market still trading?");
  expect(container()?.textContent).not.toContain("Market awaiting proof?");
  expect(container()?.textContent).not.toContain("Resolved market settled?");

  clickFilter("Closed");

  expect(container()?.textContent).toContain("Market awaiting proof?");
  expect(container()?.textContent).toContain("Expired");
  expect(container()?.textContent).toContain("Resolved YES");
  expect(container()?.textContent).not.toContain("Open market still trading?");
});

it('expired markets alone still get the status filter, so none of them sits in the active list (spec/markets/prediction.md, "Story: Close on schedule, review, resolve, or cancel")', () => {
  renderDashboard([
    predictionRow({ id: "pred-open", question: "Open market still trading?" }),
    predictionRow({ id: "pred-expired", question: "Market awaiting proof?", status: "expired", endsAtLabel: "0m" }),
  ]);

  expect(container()?.querySelector("[aria-label='Prediction status filter']")).not.toBeNull();
  expect(container()?.textContent).toContain("Open market still trading?");
  expect(container()?.textContent).not.toContain("Market awaiting proof?");
});

it('the closed status filter is labelled Closed because it also holds cancelled and expired markets (spec/markets/prediction.md, "Story: Close on schedule, review, resolve, or cancel")', () => {
  renderDashboard([
    predictionRow({ id: "pred-open", question: "Open market still trading?" }),
    predictionRow({ id: "pred-cancelled", question: "Cancelled market?", status: "cancelled" }),
    predictionRow({ id: "pred-expired", question: "Market awaiting proof?", status: "expired", endsAtLabel: "0m" }),
  ]);

  const labels = [...(container()?.querySelectorAll("[aria-label='Prediction status filter'] button") ?? [])]
    .map((button) => button.textContent?.trim());
  expect(labels).toEqual(["Active", "Closed"]);

  clickFilter("Closed");
  expect(container()?.textContent).toContain("Cancelled market?");
  expect(container()?.textContent).toContain("Market awaiting proof?");
  expect(container()?.textContent).not.toContain("Open market still trading?");
});

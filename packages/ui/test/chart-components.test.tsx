// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { PerpPriceChart } from "../src/components/PerpPriceChart.tsx";
import { PredictionProbabilityChart } from "../src/components/PredictionProbabilityChart.tsx";
import { reactRootHarness } from "./react-root.ts";

const HOUR = 3600_000;

const harness = reactRootHarness();

function renderText(node: React.ReactElement): string {
  harness.render(node);
  return harness.container?.textContent ?? "";
}

it("an empty probability history shows dashes, not an invented 50/50 split", () => {
  const text = renderText(
    <PredictionProbabilityChart marketId="seed-market-1" data={[]} timeRange="1H" />,
  );
  expect(text).toContain("YES —");
  expect(text).toContain("NO —");
  expect(text).toContain("No probability history yet.");
  expect(text).not.toContain("50.0%");
  expect(text).not.toContain("in the last 1H");
});

it("a quiet market's server-shaped history still shows its real latest odds under 1H", () => {
  const now = Date.now();
  const text = renderText(
    <PredictionProbabilityChart
      marketId="seed-market-1"
      data={[
        { time: now - 3 * 24 * HOUR, yesPrice: 0.55 },
        { time: now, yesPrice: 0.6 },
      ]}
      timeRange="1H"
    />,
  );
  expect(text).toContain("YES 60.0%");
  expect(text).toContain("NO 40.0%");
  expect(harness.container?.querySelector("[aria-label='Prediction probability chart: YES 60.0%, NO 40.0%']")).not.toBeNull();
});

it("an empty perp history says the market has no history yet, with no range claim", () => {
  const text = renderText(
    <PerpPriceChart ticker="XTRPC" data={[]} currentPrice={100} timeRange="1H" onTimeRangeChange={() => {}} />,
  );
  expect(text).toContain("No price history for $XTRPC yet.");
  expect(text).not.toContain("in the last 1H");
});

it("a quiet perp's 1H delta is measured from the single earlier point the server sends", () => {
  const now = Date.now();
  const text = renderText(
    <PerpPriceChart
      ticker="XTRPC"
      data={[
        { time: now - 3 * 24 * HOUR, price: 92 },
        { time: now, price: 100 },
      ]}
      currentPrice={100}
      timeRange="1H"
      onTimeRangeChange={() => {}}
    />,
  );
  expect(text).toContain("+8.70%");
});

it("a loading perp chart does not claim the newly selected range's delta yet", () => {
  const now = Date.now();
  const text = renderText(
    <PerpPriceChart
      ticker="XTRPC"
      data={[
        { time: now - 50 * 60_000, price: 90 },
        { time: now, price: 100 },
      ]}
      currentPrice={100}
      timeRange="1W"
      onTimeRangeChange={() => {}}
      loading
    />,
  );
  expect(text).toContain("100 pts");
  expect(text).not.toContain("+11.11%");
  expect(text).not.toContain("(1W)");
});

it("a same-range refresh keeps the settled perp delta visible", () => {
  const now = Date.now();
  const data = [
    { time: now - 50 * 60_000, price: 90 },
    { time: now, price: 100 },
  ];
  const settled = renderText(
    <PerpPriceChart ticker="XTRPC" data={data} currentPrice={100} timeRange="1D" onTimeRangeChange={() => {}} />,
  );
  expect(settled).toContain("+11.11%");
  const refreshing = renderText(
    <PerpPriceChart ticker="XTRPC" data={data} currentPrice={100} timeRange="1D" onTimeRangeChange={() => {}} loading />,
  );
  expect(refreshing).toContain("+11.11%");
  expect(refreshing).toContain("(1D)");
});

it("switching ranges hides the settled delta until the new range lands", () => {
  const now = Date.now();
  const data = [
    { time: now - 50 * 60_000, price: 90 },
    { time: now, price: 100 },
  ];
  renderText(
    <PerpPriceChart ticker="XTRPC" data={data} currentPrice={100} timeRange="1D" onTimeRangeChange={() => {}} />,
  );
  const switching = renderText(
    <PerpPriceChart ticker="XTRPC" data={data} currentPrice={100} timeRange="1W" onTimeRangeChange={() => {}} loading />,
  );
  expect(switching).not.toContain("+11.11%");
  expect(switching).not.toContain("(1W)");
  const landed = renderText(
    <PerpPriceChart ticker="XTRPC" data={data} currentPrice={100} timeRange="1W" onTimeRangeChange={() => {}} />,
  );
  expect(landed).toContain("+11.11%");
  expect(landed).toContain("(1W)");
});

it("an empty perp history claims no delta at all", () => {
  const text = renderText(
    <PerpPriceChart ticker="XTRPC" data={[]} currentPrice={100} timeRange="1H" onTimeRangeChange={() => {}} />,
  );
  expect(text).not.toContain("+0.00%");
  expect(text).not.toContain("(1H)");
});

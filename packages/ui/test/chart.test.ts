import { expect, test } from "vitest";
import { filterChartPointsByRange } from "../src/lib/chart.ts";

const HOUR = 3600_000;

test("a quiet market's 1H range keeps the single latest point from before the range, like the server", () => {
  const now = Date.now();
  const points = [
    { time: now - 48 * HOUR, yesPrice: 0.4 },
    { time: now - 27 * HOUR, yesPrice: 0.55 },
    { time: now - 25 * HOUR, yesPrice: 0.6 },
  ];
  expect(filterChartPointsByRange(points, "1H")).toEqual([
    { time: now - 27 * HOUR, yesPrice: 0.55 },
    { time: now - 25 * HOUR, yesPrice: 0.6 },
  ]);
});

test("server-shaped quiet history (one earlier point plus the live point) is returned as sent", () => {
  const now = Date.now();
  const points = [
    { time: now - 3 * 24 * HOUR, yesPrice: 0.55 },
    { time: now, yesPrice: 0.6 },
  ];
  expect(filterChartPointsByRange(points, "1H")).toEqual(points);
  expect(filterChartPointsByRange(points, "4H")).toEqual(points);
  expect(filterChartPointsByRange(points, "1D")).toEqual(points);
});

test("an unfiltered multi-day history under 1H keeps only the latest earlier point, never the full curve", () => {
  const now = Date.now();
  const points = Array.from({ length: 10 }, (_, i) => ({
    time: now - (9 - i) * 6 * HOUR,
    yesPrice: 0.4 + i * 0.02,
  }));
  const visible = filterChartPointsByRange(points, "1H");
  expect(visible).toHaveLength(2);
  expect(visible).toEqual([points[8], points[9]]);
});

test("a dense history keeps its in-range points and ALL returns everything", () => {
  const now = Date.now();
  const points = Array.from({ length: 12 }, (_, i) => ({
    time: now - (11 - i) * 30 * 60_000,
    yesPrice: 0.5 + i * 0.01,
  }));
  expect(filterChartPointsByRange(points, "1H").map((pt) => pt.yesPrice)).toEqual([0.59, 0.6, 0.61]);
  expect(filterChartPointsByRange(points, "ALL")).toEqual(points);
});

test("an empty history stays empty for any range", () => {
  expect(filterChartPointsByRange([], "1H")).toEqual([]);
  expect(filterChartPointsByRange([], "ALL")).toEqual([]);
});

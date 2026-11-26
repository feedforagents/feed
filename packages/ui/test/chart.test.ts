import { expect, test } from "vitest";
import { filterChartPointsByRange } from "../src/lib/chart.ts";

const HOUR = 3600_000;

test("a quiet market's 1H range returns only the points inside the last hour", () => {
  const now = Date.now();
  const points = [
    { time: now - 48 * HOUR, yesPrice: 0.4 },
    { time: now - 27 * HOUR, yesPrice: 0.55 },
    { time: now - 25 * HOUR, yesPrice: 0.6 },
  ];
  expect(filterChartPointsByRange(points, "1H")).toEqual([{ time: now - 25 * HOUR, yesPrice: 0.6 }]);
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

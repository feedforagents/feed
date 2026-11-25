import type { MarketTimeRange } from "../components/LightweightChartBase.tsx";

const RANGE_MS: Record<Exclude<MarketTimeRange, "ALL">, number> = {
  "1H": 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
};

function toMs(time: number): number {
  return time > 1e11 ? time : time * 1000;
}

export function filterChartPointsByRange<T extends { readonly time: number }>(
  points: readonly T[],
  timeRange: MarketTimeRange,
): T[] {
  if (points.length === 0 || timeRange === "ALL") return [...points];
  const latestMs = points.reduce((max, pt) => Math.max(max, toMs(pt.time)), 0);
  const cutoff = latestMs - RANGE_MS[timeRange];
  const filtered = points.filter((pt) => toMs(pt.time) >= cutoff);
  return filtered.length >= 2 ? filtered : [...points];
}

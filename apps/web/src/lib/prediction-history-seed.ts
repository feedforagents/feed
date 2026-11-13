import { PredictionPricing } from '@feed/core/markets/prediction/client';

/**
 * Represents a single point in prediction market price history.
 */
export interface PredictionHistoryPoint {
  /** Timestamp in milliseconds */
  time: number;
  /** Current YES outcome price (0-1) */
  yesPrice: number;
  /** Current NO outcome price (0-1) */
  noPrice: number;
  /** Trading volume since last point */
  volume: number;
  /** Total liquidity in the market */
  liquidity: number;
}

/**
 * Seed data for initializing history when API data is unavailable.
 */
export interface SeedSnapshot {
  /** Initial YES shares */
  yesShares?: number;
  /** Initial NO shares */
  noShares?: number;
  /** Initial liquidity */
  liquidity?: number;
}

/**
 * Build the two-point flat seed history shown before any recorded price
 * history exists (e.g. a brand-new market with no trades yet).
 *
 * The seed carries the market's live pool balances (markets.yesShares /
 * markets.noShares). Those are AMM inventory, not outcome totals, so the
 * current YES price must come from the canonical CPMM definition
 * (PredictionPricing.getCurrentPrice — the same definition the market pages
 * and the recorded price-history snapshots use). Using the raw share ratio
 * would draw the flat line at the complement of the current price.
 *
 * Framework-free: this module imports only the pricing client, so unit
 * tests can import it without pulling the hook's stream/auth/provider
 * graph — and its ambient browser declarations — into the testing
 * TypeScript program.
 */
export function buildPredictionSeedHistory(
  seed: SeedSnapshot
): PredictionHistoryPoint[] {
  const yesPrice = PredictionPricing.getCurrentPrice(
    seed.yesShares ?? 0,
    seed.noShares ?? 0,
    'yes'
  );
  const now = Date.now();
  const point = {
    yesPrice,
    noPrice: 1 - yesPrice,
    volume: 0,
    liquidity: seed.liquidity ?? 0,
  };
  return [
    { time: now - 60_000, ...point },
    { time: now, ...point },
  ];
}

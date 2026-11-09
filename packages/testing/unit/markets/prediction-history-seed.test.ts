import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction/client';

import { buildPredictionSeedHistory } from '../../../../apps/web/src/lib/prediction-history-seed';

/**
 * The chart seed for a prediction market carries the market's live pool
 * balances (markets.yesShares / markets.noShares, passed by NewMarketCard
 * and the markets terminal). Those are AMM inventory, not outcome totals:
 * a market seeded at 80% YES stores yesShares=2000 / noShares=8000, and
 * its CPMM YES price is 0.8. When a market has no recorded price history
 * yet (no trades — price snapshots are only written on buy/sell/resolve/
 * cancel), the seed flat line is the entire chart, and the chart header
 * reads the latest point as the current probability. The seed must
 * therefore price the pool with the canonical CPMM definition, not the
 * raw share ratio (which is the complement of the price).
 */
describe('prediction history seed', () => {
  it('prices an 80% market seed at 0.8, not its complement', () => {
    // Real creation path: PredictionDbAdapter stores initializeMarket's
    // pool balances on the markets row.
    const pool = PredictionPricing.initializeMarket(10_000, 0.8);
    expect(pool.yesShares).toBe(2000);
    expect(pool.noShares).toBe(8000);

    const points = buildPredictionSeedHistory({
      yesShares: pool.yesShares,
      noShares: pool.noShares,
      liquidity: pool.yesShares + pool.noShares,
    });

    expect(points).toHaveLength(2);
    for (const point of points) {
      expect(point.yesPrice).toBe(0.8);
      expect(point.noPrice).toBeCloseTo(0.2, 10);
      expect(point.liquidity).toBe(10_000);
    }
    expect(points[0]!.time).toBeLessThan(points[1]!.time);
  });

  it('prices a 20% market seed at 0.2, not its complement', () => {
    const pool = PredictionPricing.initializeMarket(10_000, 0.2);

    const points = buildPredictionSeedHistory({
      yesShares: pool.yesShares,
      noShares: pool.noShares,
    });

    expect(points).toHaveLength(2);
    for (const point of points) {
      expect(point.yesPrice).toBe(0.2);
      expect(point.noPrice).toBeCloseTo(0.8, 10);
    }
  });

  it('tracks the pool after a real YES buy moves the price up', () => {
    // Real trade math: buying YES draws YES shares out of the pool and
    // the service stores calc.newYesShares/newNoShares on the row; the
    // terminal seeds the chart from those live balances.
    const calc = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);
    const expected = PredictionPricing.getCurrentPrice(
      calc.newYesShares,
      calc.newNoShares,
      'yes'
    );
    expect(expected).toBeGreaterThan(0.5);

    const points = buildPredictionSeedHistory({
      yesShares: calc.newYesShares,
      noShares: calc.newNoShares,
    });

    for (const point of points) {
      expect(point.yesPrice).toBe(expected);
    }
  });

  it('keeps a balanced pool at 0.5 (guard)', () => {
    const points = buildPredictionSeedHistory({
      yesShares: 5000,
      noShares: 5000,
    });

    for (const point of points) {
      expect(point.yesPrice).toBe(0.5);
      expect(point.noPrice).toBe(0.5);
    }
  });

  it('keeps an empty pool at 0.5 (guard)', () => {
    const points = buildPredictionSeedHistory({ yesShares: 0, noShares: 0 });

    for (const point of points) {
      expect(point.yesPrice).toBe(0.5);
    }
  });
});

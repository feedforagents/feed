import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction/client';

import { computePercentages as computeNewMarketPercentages } from '../../../../apps/web/src/app/feed/components/NewMarketCard';
import { computePercentages as computeResolvedPercentages } from '../../../../apps/web/src/app/feed/components/ResolvedMarketFeedCard';

/**
 * The feed cards receive the market's live pool balances (markets.yesShares /
 * markets.noShares, carried through the feed pipelines unchanged). Those are
 * AMM inventory, not outcome totals: a market seeded at 80% YES stores
 * yesShares=2000 / noShares=8000, and its CPMM YES price is 0.8.
 * The cards must display that price, not the share ratio.
 */
const cards = [
  ['NewMarketCard', computeNewMarketPercentages],
  ['ResolvedMarketFeedCard', computeResolvedPercentages],
] as const;

describe('feed card percentages', () => {
  for (const [name, computePercentages] of cards) {
    describe(name, () => {
      it('shows the seeded price for an 80% market, not its complement', () => {
        // Real creation path: PredictionDbAdapter stores initializeMarket's
        // pool balances on the markets row.
        const pool = PredictionPricing.initializeMarket(10_000, 0.8);
        expect(pool.yesShares).toBe(2000);
        expect(pool.noShares).toBe(8000);

        const result = computePercentages(pool.yesShares, pool.noShares);
        expect(result.yesPercent).toBe(80);
        expect(result.noPercent).toBe(20);
      });

      it('shows the seeded price for a 20% market, not its complement', () => {
        const pool = PredictionPricing.initializeMarket(10_000, 0.2);

        const result = computePercentages(pool.yesShares, pool.noShares);
        expect(result.yesPercent).toBe(20);
        expect(result.noPercent).toBe(80);
      });

      it('tracks the pool after a real YES buy moves the price up', () => {
        // Real trade math: buying YES draws YES shares out of the pool and
        // the service stores calc.newYesShares/newNoShares on the row.
        const calc = PredictionPricing.calculateBuy(5000, 5000, 'yes', 1000);
        const expectedYesPercent = Math.round(
          PredictionPricing.getCurrentPrice(
            calc.newYesShares,
            calc.newNoShares,
            'yes'
          ) * 100
        );
        expect(expectedYesPercent).toBeGreaterThan(50);

        const result = computePercentages(calc.newYesShares, calc.newNoShares);
        expect(result.yesPercent).toBe(expectedYesPercent);
        expect(result.yesPercent + result.noPercent).toBe(100);
      });

      it('keeps 50/50 for an even pool and for an empty pool (guards)', () => {
        expect(computePercentages(5000, 5000)).toEqual({
          yesPercent: 50,
          noPercent: 50,
        });
        expect(computePercentages(0, 0)).toEqual({
          yesPercent: 50,
          noPercent: 50,
        });
      });
    });
  }

  it('both cards agree with each other and with the canonical price', () => {
    const pool = PredictionPricing.initializeMarket(10_000, 0.8);
    const canonical = Math.round(
      PredictionPricing.getCurrentPrice(pool.yesShares, pool.noShares, 'yes') *
        100
    );
    expect(computeNewMarketPercentages(pool.yesShares, pool.noShares)).toEqual({
      yesPercent: canonical,
      noPercent: 100 - canonical,
    });
    expect(computeResolvedPercentages(pool.yesShares, pool.noShares)).toEqual({
      yesPercent: canonical,
      noPercent: 100 - canonical,
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction/client';
import { buildPredictionWinPreview } from './prediction-win-preview';

/**
 * PRD §9.2 [D-14]: a winning share redeems for exactly 1 pt, so the buy
 * preview's "If <side> Wins" figure is the share count, not the cost
 * basis. The old preview called
 * `calculateExpectedPayout(sharesBought, avgPrice)` with no pool
 * aggregates, which returns shares × avgPrice — identically the amount
 * paid — so it showed profit 0 for every trade.
 */
describe('buildPredictionWinPreview', () => {
  it('values a balanced-pool buy at 1 pt per share received', () => {
    const calc = PredictionPricing.calculateBuy(5000, 5000, 'yes', 100);
    const preview = buildPredictionWinPreview(calc.sharesBought, 100);
    expect(preview.expectedPayout).toBeCloseTo(calc.sharesBought, 8);
    expect(preview.expectedProfit).toBeCloseTo(calc.sharesBought - 100, 8);
  });

  it('shows a large win payout for a cheap-side buy, not the stake back', () => {
    // YES is cheap in a 9000/1000 pool: 100 pts receive ~818 shares.
    const calc = PredictionPricing.calculateBuy(9000, 1000, 'yes', 100);
    expect(calc.sharesBought).toBeGreaterThan(800);
    const preview = buildPredictionWinPreview(calc.sharesBought, 100);
    expect(preview.expectedPayout).toBeCloseTo(818.18, 2);
    expect(preview.expectedProfit).toBeCloseTo(718.18, 2);
    // The old two-argument calculateExpectedPayout returned exactly 100
    // here (cost basis), i.e. a displayed profit of 0.
    expect(
      PredictionPricing.calculateExpectedPayout(
        calc.sharesBought,
        calc.avgPrice
      )
    ).toBeCloseTo(100, 8);
    expect(preview.expectedPayout).not.toBeCloseTo(100, 2);
  });

  it('shows a small win payout for a favourite-side buy, not the stake back', () => {
    // YES is the favourite in a 1000/9000 pool: 100 pts receive ~11 shares.
    const calc = PredictionPricing.calculateBuy(1000, 9000, 'yes', 100);
    expect(calc.sharesBought).toBeLessThan(12);
    const preview = buildPredictionWinPreview(calc.sharesBought, 100);
    expect(preview.expectedPayout).toBeCloseTo(calc.sharesBought, 8);
    expect(preview.expectedProfit).toBeLessThan(-89);
  });

  it('counts profit against the gross amount paid, fees included', () => {
    const calc = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      100,
      0.01
    );
    const preview = buildPredictionWinPreview(calc.sharesBought, 100);
    expect(preview.expectedPayout).toBeCloseTo(calc.sharesBought, 8);
    expect(preview.expectedProfit).toBeCloseTo(calc.sharesBought - 100, 8);
    expect(preview.expectedProfit).toBeLessThan(0);
  });

  it('is zero when no shares are bought', () => {
    const preview = buildPredictionWinPreview(0, 0);
    expect(preview.expectedPayout).toBe(0);
    expect(preview.expectedProfit).toBe(0);
  });
});

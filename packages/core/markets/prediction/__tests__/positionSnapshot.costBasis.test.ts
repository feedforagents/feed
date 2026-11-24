import { describe, expect, it } from 'bun:test';
import { calculatePredictionPositionSnapshot } from '../positionSnapshot';
import { PredictionPricing } from '../pricing';

describe('calculatePredictionPositionSnapshot persisted cashCostBasis (PRD §9.1)', () => {
  it('uses persisted cashCostBasis for small buys where the canonical fee rounds up to 0.01 pt', () => {
    // PRD §9.1: a 1 pt buy at 0.1% pays a 0.01 pt fee (effective 1%), so
    // shares * avgPrice is 0.99 while the trader paid 1.00 pt in cash.
    const buy = PredictionPricing.calculateBuyWithFees(
      5_000,
      5_000,
      'yes',
      1,
      0.001
    );
    expect(buy.fee).toBe(0.01);
    expect(buy.netAmount).toBe(0.99);

    const snapshot = calculatePredictionPositionSnapshot({
      shares: buy.sharesBought,
      avgPrice: buy.avgPrice,
      cashCostBasis: 1,
      side: 'yes',
      yesShares: buy.newYesShares,
      noShares: buy.newNoShares,
      feeRate: 0.001,
    });

    expect(snapshot.costBasis).toBe(1);
    expect(snapshot.unrealizedPnL).toBeCloseTo(snapshot.currentValue - 1, 10);
  });

  it('uses persisted cashCostBasis when the position was opened at a historical fee rate', () => {
    // 100 pt buy opened at the old 1% fee rate (net cost = 99, cash paid = 100),
    // marked under the current 0.1% fee rate.
    const buy = PredictionPricing.calculateBuyWithFees(
      5_000,
      5_000,
      'yes',
      100,
      0.01
    );
    expect(buy.fee).toBe(1);
    expect(buy.netAmount).toBe(99);

    const snapshot = calculatePredictionPositionSnapshot({
      shares: buy.sharesBought,
      avgPrice: buy.avgPrice,
      cashCostBasis: 100,
      side: 'yes',
      yesShares: buy.newYesShares,
      noShares: buy.newNoShares,
      feeRate: 0.001,
    });

    expect(snapshot.costBasis).toBe(100);
    expect(snapshot.unrealizedPnL).toBeCloseTo(snapshot.currentValue - 100, 10);
  });

  it('falls back to grossed-up net cost when a settled row has cashCostBasis zeroed while retaining shares', () => {
    // PredictionMarketService.resolve() and cancel() zero cashCostBasis while
    // keeping shares and avgPrice on the settled row.
    const snapshot = calculatePredictionPositionSnapshot({
      shares: 10,
      avgPrice: 0.5,
      cashCostBasis: 0,
      side: 'yes',
      yesShares: 5_000,
      noShares: 5_000,
      feeRate: 0.001,
      resolved: true,
      resolution: true,
    });

    const expectedFallback = (10 * 0.5) / (1 - 0.001);
    expect(snapshot.costBasis).toBeCloseTo(expectedFallback, 10);
    expect(snapshot.currentValue).toBe(10);
    expect(snapshot.unrealizedPnL).toBeCloseTo(10 - expectedFallback, 10);
  });

  it('preserves zero costBasis on closed zero-share rows and gross-up fallback when cashCostBasis is absent or non-finite', () => {
    const closed = calculatePredictionPositionSnapshot({
      shares: 0,
      avgPrice: 0.5,
      cashCostBasis: 0,
      side: 'yes',
      yesShares: 5_000,
      noShares: 5_000,
      feeRate: 0.001,
    });
    expect(closed.costBasis).toBe(0);
    expect(closed.currentValue).toBe(0);
    expect(closed.unrealizedPnL).toBe(0);

    const legacyNull = calculatePredictionPositionSnapshot({
      shares: 10,
      avgPrice: 0.5,
      cashCostBasis: null,
      side: 'yes',
      yesShares: 5_000,
      noShares: 5_000,
      feeRate: 0.001,
    });
    expect(legacyNull.costBasis).toBeCloseTo((10 * 0.5) / (1 - 0.001), 10);

    const nonFinite = calculatePredictionPositionSnapshot({
      shares: 10,
      avgPrice: 0.5,
      cashCostBasis: Number.NaN,
      side: 'yes',
      yesShares: 5_000,
      noShares: 5_000,
      feeRate: 0.001,
    });
    expect(nonFinite.costBasis).toBeCloseTo((10 * 0.5) / (1 - 0.001), 10);
  });
});

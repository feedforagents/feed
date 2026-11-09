import { describe, expect, it } from 'bun:test';
import { predictionPositionPnLPercent } from './position-pnl';

describe('predictionPositionPnLPercent', () => {
  it('derives the percent from unrealizedPnL over the fee-grossed cost basis', () => {
    // 100 shares @ 0.5 in a 49900/50100 pool: snapshot currentValue
    // 50.02 against costBasis 50.0501 is a small loss, even though the
    // unit price (0.5002) sits above the average entry price (0.5).
    const percent = predictionPositionPnLPercent({
      unrealizedPnL: -0.0301,
      costBasis: 50.0501,
    });
    expect(percent).toBeCloseTo(-0.0601, 3);
    expect(percent).toBeLessThan(0);
  });

  it('matches the wallet tab percent for a gaining position', () => {
    const percent = predictionPositionPnLPercent({
      unrealizedPnL: 0.0199,
      costBasis: 50.0501,
    });
    expect(percent).toBeCloseTo(0.0398, 3);
    expect(percent).toBeGreaterThan(0);
  });

  it('returns 0 when the cost basis is 0', () => {
    expect(
      predictionPositionPnLPercent({ unrealizedPnL: 5, costBasis: 0 })
    ).toBe(0);
  });
});

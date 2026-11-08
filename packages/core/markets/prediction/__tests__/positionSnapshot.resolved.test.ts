import { describe, expect, test } from 'bun:test';
import { calculatePredictionPositionSnapshot } from '../positionSnapshot';
import { PredictionPricing } from '../pricing';

describe('resolved winning snapshot uses settled credit (PRD §9.1, §9.2)', () => {
  test('currentValue uses the floored payout and P&L uses that value', () => {
    // Ordinary trade: 10 pts YES buy on a fresh 5000/5000 pool at 1% fee
    const buy = PredictionPricing.calculateBuyWithFees(
      5000,
      5000,
      'yes',
      10,
      0.01
    );
    const shares = buy.sharesBought; // fractional share quantity
    const settled = PredictionPricing.calculateExpectedPayout(
      shares,
      buy.avgPrice
    );

    const snap = calculatePredictionPositionSnapshot({
      shares,
      avgPrice: buy.avgPrice,
      side: 'yes',
      yesShares: buy.newYesShares,
      noShares: buy.newNoShares,
      feeRate: 0.01,
      resolved: true,
      resolution: true,
    });

    expect(settled).not.toBe(shares); // precondition: shares finer than 2dp
    expect(snap.currentValue).toBe(settled);
    expect(snap.unrealizedPnL).toBeCloseTo(settled - snap.costBasis, 10);
  });

  test('losers are worthless and invalid negative winning shares are rejected', () => {
    const losing = calculatePredictionPositionSnapshot({
      shares: 3.456,
      avgPrice: 0.4,
      side: 'yes',
      yesShares: 5000,
      noShares: 5000,
      feeRate: 0,
      resolved: true,
      resolution: false,
    });

    expect(losing.currentValue).toBe(0);
    expect(losing.unrealizedPnL).toBe(-1.3824);
    expect(() =>
      calculatePredictionPositionSnapshot({
        shares: -1,
        avgPrice: 0.4,
        side: 'yes',
        yesShares: 5000,
        noShares: 5000,
        feeRate: 0,
        resolved: true,
        resolution: true,
      })
    ).toThrow('Points must be a finite non-negative amount');
  });
});

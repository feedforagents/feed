import { describe, expect, it } from 'bun:test';
import {
  type PredictionMarketRecord,
  type PredictionPositionRecord,
  PredictionPricing,
} from '@feed/core/markets/prediction';
import { buildPredictionUserPositionSnapshot } from './_position-snapshot';

const market: PredictionMarketRecord = {
  id: 'market-1',
  question: 'Will it rain tomorrow?',
  yesShares: 5_000,
  noShares: 5_000,
  liquidity: 10_000,
  endDate: new Date('2026-12-31T00:00:00Z'),
  resolved: false,
  resolution: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function position(
  overrides: Partial<PredictionPositionRecord>
): PredictionPositionRecord {
  return {
    id: 'pos-1',
    userId: 'user-1',
    marketId: 'market-1',
    side: 'yes',
    shares: 100,
    avgPrice: 0.5,
    status: 'active',
    outcome: null,
    pnl: 0,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('buildPredictionUserPositionSnapshot maxPayout', () => {
  it('equals the settled credit for a win: 1 pt per share, floored to cents', () => {
    const shares = 123.456789;
    const snapshot = buildPredictionUserPositionSnapshot(
      position({ shares, avgPrice: 0.5 }),
      market
    );
    expect(snapshot).not.toBeNull();
    // PRD §9.2 [D-14] + §9.1: the win preview must be the amount settlement
    // actually credits, i.e. PredictionPricing.calculateExpectedPayout.
    expect(snapshot!.maxPayout).toBe(
      PredictionPricing.calculateExpectedPayout(shares, 0.5)
    );
    expect(snapshot!.maxPayout).toBe(123.45);
  });

  it('does not add the stake on top of the redemption', () => {
    const snapshot = buildPredictionUserPositionSnapshot(
      position({ shares: 10, avgPrice: 0.9 }),
      market
    );
    expect(snapshot!.maxPayout).toBe(10);
  });

  it('still hides dust positions', () => {
    expect(
      buildPredictionUserPositionSnapshot(position({ shares: 0.001 }), market)
    ).toBeNull();
  });
});

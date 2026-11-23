import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { mapUserPredictionPositionSnapshot } from './user-positions';

describe('mapUserPredictionPositionSnapshot persisted cashCostBasis', () => {
  it('uses persisted cashCostBasis for active prediction positions', () => {
    const buy = PredictionPricing.calculateBuyWithFees(
      5_000,
      5_000,
      'yes',
      1,
      FEE_CONFIG.TRADING_FEE_RATE
    );
    const snapshot = mapUserPredictionPositionSnapshot(
      {
        id: 'pos-1',
        marketId: 'mkt-1',
        side: true,
        shares: String(buy.sharesBought),
        avgPrice: String(buy.avgPrice),
        cashCostBasis: '1.00',
        status: 'active',
        createdAt: new Date('2026-11-01T00:00:00Z'),
        outcome: null,
        pnl: '0.00',
        resolvedAt: null,
      },
      {
        question: 'Will cost basis match cash paid?',
        endDate: new Date('2026-12-01T00:00:00Z'),
        resolved: false,
        resolution: null,
        yesShares: String(buy.newYesShares),
        noShares: String(buy.newNoShares),
      }
    );

    expect(snapshot.costBasis).toBe(1);
    expect(snapshot.unrealizedPnL).toBeCloseTo(snapshot.currentValue - 1, 10);
  });

  it('falls back cleanly when resolved rows zero cashCostBasis or legacy rows omit it', () => {
    const resolved = mapUserPredictionPositionSnapshot(
      {
        id: 'pos-resolved',
        marketId: 'mkt-1',
        side: true,
        shares: '10',
        avgPrice: '0.5',
        cashCostBasis: '0.00',
        status: 'resolved',
        createdAt: new Date('2026-11-01T00:00:00Z'),
        outcome: true,
        pnl: '5.00',
        resolvedAt: new Date('2026-11-02T00:00:00Z'),
      },
      {
        question: 'Resolved market',
        endDate: new Date('2026-11-02T00:00:00Z'),
        resolved: true,
        resolution: true,
        yesShares: '5000',
        noShares: '5000',
      }
    );

    const expectedFallback = 5 / (1 - FEE_CONFIG.TRADING_FEE_RATE);
    expect(resolved.costBasis).toBeCloseTo(expectedFallback, 10);

    const legacy = mapUserPredictionPositionSnapshot(
      {
        id: 'pos-legacy',
        marketId: 'mkt-1',
        side: true,
        shares: '10',
        avgPrice: '0.5',
        cashCostBasis: null,
        status: 'active',
        createdAt: new Date('2026-11-01T00:00:00Z'),
        outcome: null,
        pnl: '0.00',
        resolvedAt: null,
      },
      {
        question: 'Legacy row market',
        endDate: new Date('2026-12-01T00:00:00Z'),
        resolved: false,
        resolution: null,
        yesShares: '5000',
        noShares: '5000',
      }
    );

    expect(legacy.costBasis).toBeCloseTo(expectedFallback, 10);
  });
});

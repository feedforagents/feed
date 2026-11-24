import { describe, expect, it } from 'bun:test';
import { PredictionPricing } from '@feed/core/markets/prediction';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import {
  buildPnlMetricIdentityMap,
  buildScopedPnlHistoryPoints,
  calculatePredictionRowUnrealizedPnL,
  getHourBoundary,
} from './pnlHistory';

describe('buildScopedPnlHistoryPoints', () => {
  it('aggregates snapshots across the full team scope and appends a live point', () => {
    const now = new Date('2026-03-20T20:45:00.000Z');
    const points = buildScopedPnlHistoryPoints({
      now,
      scopeUserIds: ['owner-1', 'agent-1'],
      snapshots: [
        {
          userId: 'owner-1',
          snapshotAt: new Date('2026-03-20T18:00:00.000Z'),
          currentPnL: 10,
        },
        {
          userId: 'agent-1',
          snapshotAt: new Date('2026-03-20T18:00:00.000Z'),
          currentPnL: 5,
        },
        {
          userId: 'owner-1',
          snapshotAt: new Date('2026-03-20T19:00:00.000Z'),
          currentPnL: 12,
        },
        {
          userId: 'agent-1',
          snapshotAt: new Date('2026-03-20T19:00:00.000Z'),
          currentPnL: 8,
        },
      ],
      liveMetricsByUserId: new Map([
        [
          'owner-1',
          {
            userId: 'owner-1',
            lifetimePnL: 0,
            unrealizedPnL: 0,
            currentPnL: 14,
          },
        ],
        [
          'agent-1',
          {
            userId: 'agent-1',
            lifetimePnL: 0,
            unrealizedPnL: 0,
            currentPnL: 9,
          },
        ],
      ]),
    });

    expect(points).toEqual([
      { time: new Date('2026-03-20T18:00:00.000Z').getTime(), value: 15 },
      { time: new Date('2026-03-20T19:00:00.000Z').getTime(), value: 20 },
      { time: now.getTime(), value: 23 },
    ]);
  });

  it('isolates a single agent scope from team snapshots', () => {
    const points = buildScopedPnlHistoryPoints({
      scopeUserIds: ['agent-2'],
      snapshots: [
        {
          userId: 'owner-1',
          snapshotAt: new Date('2026-03-20T18:00:00.000Z'),
          currentPnL: 10,
        },
        {
          userId: 'agent-2',
          snapshotAt: new Date('2026-03-20T18:00:00.000Z'),
          currentPnL: -3,
        },
      ],
    });

    expect(points).toEqual([
      { time: new Date('2026-03-20T18:00:00.000Z').getTime(), value: -3 },
    ]);
  });
});

describe('buildScopedPnlHistoryPoints downsampling', () => {
  it('never returns more than maxPoints and ends on the latest point', () => {
    const start = Date.UTC(2026, 0, 1);
    const snapshots = Array.from({ length: 25 }, (_, i) => ({
      userId: 'u1',
      snapshotAt: new Date(start + i * 3_600_000),
      currentPnL: i,
    }));
    const points = buildScopedPnlHistoryPoints({
      now: new Date(start + 30 * 3_600_000),
      scopeUserIds: ['u1'],
      snapshots,
      maxPoints: 10,
    });
    expect(points.length).toBeLessThanOrEqual(10);
    expect(points.at(-1)?.value).toBe(24);
  });
});

describe('getHourBoundary', () => {
  it('normalizes dates to the top of the UTC hour', () => {
    expect(
      getHourBoundary(new Date('2026-03-20T20:45:31.222Z')).toISOString()
    ).toBe('2026-03-20T20:00:00.000Z');
  });
});

describe('buildPnlMetricIdentityMap', () => {
  it('maps privy aliases back to the canonical user id', () => {
    const result = buildPnlMetricIdentityMap([
      {
        id: 'owner-1',
        lifetimePnL: '12',
        privyId: 'did:privy:owner-1',
      },
      {
        id: 'agent-1',
        lifetimePnL: '5',
        privyId: null,
      },
    ]);

    expect(result.positionUserIds).toEqual([
      'owner-1',
      'did:privy:owner-1',
      'agent-1',
    ]);
    expect(result.aliasToCanonicalUserId.get('owner-1')).toBe('owner-1');
    expect(result.aliasToCanonicalUserId.get('did:privy:owner-1')).toBe(
      'owner-1'
    );
    expect(result.aliasToCanonicalUserId.get('agent-1')).toBe('agent-1');
  });
});

describe('calculatePredictionRowUnrealizedPnL', () => {
  it('marks active prediction unrealized PnL against persisted cashCostBasis', () => {
    const buy = PredictionPricing.calculateBuyWithFees(
      5_000,
      5_000,
      'yes',
      1,
      FEE_CONFIG.TRADING_FEE_RATE
    );
    const sellPreview = PredictionPricing.calculateSellWithFees(
      buy.newYesShares,
      buy.newNoShares,
      'yes',
      buy.sharesBought,
      FEE_CONFIG.TRADING_FEE_RATE
    );

    const pnl = calculatePredictionRowUnrealizedPnL({
      shares: String(buy.sharesBought),
      avgPrice: String(buy.avgPrice),
      cashCostBasis: '1.00',
      side: true,
      yesShares: String(buy.newYesShares),
      noShares: String(buy.newNoShares),
    });

    expect(pnl).toBeCloseTo((sellPreview.netProceeds ?? 0) - 1, 10);
  });
});

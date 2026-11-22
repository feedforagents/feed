/**
 * Trading dashboard exposure must measure perp positions by posted margin,
 * not leveraged notional.
 *
 * perpPositions.size is the leveraged notional (PerpMarketService debits
 * size / leverage as margin), while every other portfolio computation in the
 * codebase (getPositionExposure, calculatePerpPositionMarketValue,
 * NPCInvestmentManager.getPortfolioMetrics) values an open perp at its
 * margin. calculatePortfolioExposure summed raw size, so a 5x perp with
 * $1,000 notional on a $1,000 cash balance showed 50% exposure when only
 * $200 (16.7%) was actually deployed. The LLM reads that Exposure line on
 * every tick, so it held back from trading on a phantom deployment.
 */
import { describe, expect, test } from 'bun:test';
import type { NPCMarketContext, NPCPosition } from '../../types/market-context';
import {
  calculatePortfolioExposure,
  formatSingleNPCDashboard,
} from '../../utils/trading-dashboard-format';

const perp = (
  size: number,
  leverage?: number,
  unrealizedPnL = 0
): NPCPosition =>
  ({
    id: 'pos-perp',
    marketType: 'perp',
    ticker: 'TSLAI',
    side: 'long',
    entryPrice: 450,
    currentPrice: 450,
    size,
    unrealizedPnL,
    openedAt: '2026-11-11T00:00:00Z',
    ...(leverage !== undefined ? { leverage } : {}),
  }) as NPCPosition;

const prediction = (size: number, unrealizedPnL = 0): NPCPosition => ({
  id: 'pos-pred',
  marketType: 'prediction',
  marketId: 'q1',
  side: 'YES',
  entryPrice: 0.5,
  currentPrice: 0.5,
  size,
  unrealizedPnL,
  openedAt: '2026-11-11T00:00:00Z',
});

describe('calculatePortfolioExposure', () => {
  test('measures a leveraged perp by margin, not notional', () => {
    // $1,000 cash + 5x perp with $1,000 notional = $200 margin deployed.
    expect(calculatePortfolioExposure(1000, [perp(1000, 5)])).toBeCloseTo(
      (200 / 1200) * 100,
      5
    );
  });

  test('adds unrealized PnL to the margin value', () => {
    // Margin $200 + $100 PnL = $300 position value on $1,000 cash.
    expect(calculatePortfolioExposure(1000, [perp(1000, 5, 100)])).toBeCloseTo(
      (300 / 1300) * 100,
      5
    );
  });

  test('leaves prediction positions at cash cost', () => {
    expect(calculatePortfolioExposure(1000, [prediction(500)])).toBeCloseTo(
      (500 / 1500) * 100,
      5
    );
  });

  test('mixes perp margin and prediction cost in one total', () => {
    // Perp margin $200 + prediction $500 = $700 deployed on $1,000 cash.
    expect(
      calculatePortfolioExposure(1000, [perp(1000, 5), prediction(500)])
    ).toBeCloseTo((700 / 1700) * 100, 5);
  });

  test('falls back to notional when leverage is missing', () => {
    expect(calculatePortfolioExposure(1000, [perp(1000)])).toBeCloseTo(50, 5);
  });
});

describe('formatSingleNPCDashboard', () => {
  test('shows margin-based exposure for a leveraged perp', () => {
    const context: NPCMarketContext = {
      npcId: 'npc-a',
      npcName: 'NPC A',
      personality: 'careful',
      tier: 'A',
      availableBalance: 1000,
      recentPosts: [],
      groupChatMessages: [],
      recentEvents: [],
      perpMarkets: [],
      predictionMarkets: [],
      currentPositions: [perp(1000, 5)],
    };
    expect(formatSingleNPCDashboard(context)).toContain('Exposure: 16.7%');
  });
});

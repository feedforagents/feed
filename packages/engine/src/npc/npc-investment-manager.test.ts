import { describe, expect, it } from 'bun:test';
import {
  NPCInvestmentManager,
  type PortfolioPosition,
} from './npc-investment-manager';

// calculateRiskScore is private; reach it through a typed cast so the test
// pins the scoring behaviour without going through the database.
const calculateRiskScore = (
  NPCInvestmentManager as unknown as {
    calculateRiskScore: (
      positions: PortfolioPosition[],
      totalValue: number
    ) => number;
  }
).calculateRiskScore;

function makePosition(
  overrides: Partial<PortfolioPosition> & { id: string }
): PortfolioPosition {
  return {
    poolId: 'pool-1',
    marketType: 'prediction',
    side: 'long',
    size: 1_000,
    entryPrice: 100,
    currentPrice: 100,
    unrealizedPnL: 0,
    ...overrides,
  };
}

describe('calculateRiskScore concentration factor', () => {
  it('counts a concentrated perp position by its margin exposure, not its unrealized PnL', () => {
    // One perp position holds 90% of a $100k portfolio (margin $90k) but has
    // zero unrealized PnL. Concentration must be 0.9, so with 10x leverage
    // the score is 0.4 (leverage) + 0.3 * 0.9 (concentration) = 0.67.
    const positions = [
      makePosition({
        id: 'pos-1',
        marketType: 'perp',
        size: 900_000,
        leverage: 10,
        unrealizedPnL: 0,
      }),
    ];

    expect(calculateRiskScore(positions, 100_000)).toBeCloseTo(0.67, 6);
  });

  it('does not let a small position with a large unrealized gain stand in for the largest position', () => {
    // Position A holds $90k of the portfolio with no PnL; position B is a
    // $1k position sitting on a $5k unrealized gain. Concentration must come
    // from A (0.9), not from B's $5k gain (0.05).
    const positions = [
      makePosition({ id: 'pos-a', size: 90_000, unrealizedPnL: 0 }),
      makePosition({ id: 'pos-b', size: 1_000, unrealizedPnL: 5_000 }),
    ];

    // 0.4 * (1/10 leverage) + 0.3 * 0.9 concentration + 0 drawdown = 0.31.
    expect(calculateRiskScore(positions, 100_000)).toBeCloseTo(0.31, 6);
  });

  it('stays low for a diversified portfolio with no unrealized PnL', () => {
    const positions = Array.from({ length: 10 }, (_, index) =>
      makePosition({ id: `pos-${index}`, size: 1_000, unrealizedPnL: 0 })
    );

    // 0.4 * 0.1 leverage + 0.3 * 0.01 concentration = 0.043.
    expect(calculateRiskScore(positions, 100_000)).toBeCloseTo(0.043, 6);
  });

  it('returns 0 when there are no positions', () => {
    expect(calculateRiskScore([], 100_000)).toBe(0);
  });
});

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * PRD §9.1, §9.2 [D-14] & MVP Phase 6:
 * `PredictionMarketService.cancel()` refunds the user's gross cash cost basis
 * back to `virtualBalance`, zeroes `Position.cashCostBasis`, and sets
 * `Position.status = 'cancelled'`, while preserving historical `shares` and
 * leaving `Market.resolved = false`.
 *
 * Open prediction readers (`calculatePortfolioPnL` and
 * `calculatePortfolioBreakdown`) must require `Position.status = 'active'`
 * alongside `Market.resolved = false`; otherwise cancelled/closed positions
 * with `cashCostBasis = 0` and retained `shares > 0` are marked to market on
 * top of the already-refunded cash balance.
 */

const actualDb = await import('@feed/db');
const { balanceTransactions, perpPositions, positions, users } = actualDb;

const dialect = new PgDialect();

function renderSql(predicate: unknown): { text: string; params: unknown[] } {
  const rendered = dialect.sqlToQuery(predicate as SQL);
  return {
    text: rendered.sql.replace(/\s+/g, ' ').trim(),
    params: rendered.params,
  };
}

function extractEqParam(
  rendered: { text: string; params: unknown[] },
  columnPattern: RegExp
): unknown {
  const match = columnPattern.exec(rendered.text);
  if (!match) return undefined;
  const paramIndex = Number(match[1]) - 1;
  return rendered.params[paramIndex];
}

interface MockPositionRow {
  userId: string;
  status: string;
  resolved: boolean;
  shares: string;
  avgPrice: string;
  cashCostBasis: string | null;
  side: boolean;
  marketYesShares: string;
  marketNoShares: string;
}

const currentUser = {
  id: 'user-cancel-1',
  privyId: null,
  virtualBalance: '1000.00',
  totalDeposited: '1000.00',
  totalWithdrawn: '0.00',
  lifetimePnL: '0.00',
};

let storedPositions: MockPositionRow[] = [];
const capturedPositionPredicates: Array<{ text: string; params: unknown[] }> =
  [];

const mockSelect = mock(() => ({
  from: (table: unknown) => {
    const executeWhere = (predicate: unknown) => {
      let rows: unknown[] = [];

      if (table === users) {
        rows = [currentUser];
      } else if (table === perpPositions) {
        rows = [];
      } else if (table === balanceTransactions) {
        rows = [{ netPeerTransfers: '0', netTransfers: '0' }];
      } else if (table === positions) {
        const rendered = renderSql(predicate);
        capturedPositionPredicates.push(rendered);

        const statusFilter = extractEqParam(
          rendered,
          /(?:"Position"\.)?"status"\s*=\s*\$(\d+)/
        );
        const resolvedFilter = extractEqParam(
          rendered,
          /(?:"Market"\.)?"resolved"\s*=\s*\$(\d+)/
        );

        rows = storedPositions.filter((row) => {
          if (statusFilter !== undefined && row.status !== statusFilter) {
            return false;
          }
          if (resolvedFilter !== undefined && row.resolved !== resolvedFilter) {
            return false;
          }
          return true;
        });
      }

      return Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
      });
    };

    return {
      innerJoin: () => ({
        where: executeWhere,
      }),
      where: executeWhere,
    };
  },
}));

mock.module('@feed/db', () => ({
  ...actualDb,
  db: {
    select: mockSelect,
  },
}));

const pnlModuleUrl = new URL(
  '../../engine/src/services/portfolio-pnl.ts',
  import.meta.url
);
pnlModuleUrl.searchParams.set(
  'test',
  'portfolio-cancelled-prediction-positions'
);
const { calculatePortfolioPnL } = await import(pnlModuleUrl.href);

const breakdownModuleUrl = new URL(
  '../../engine/src/services/portfolio-breakdown.ts',
  import.meta.url
);
breakdownModuleUrl.searchParams.set(
  'test',
  'portfolio-cancelled-prediction-positions'
);
const { calculatePortfolioBreakdown } = await import(breakdownModuleUrl.href);

describe('Cancelled prediction positions in open portfolio valuation', () => {
  beforeEach(() => {
    capturedPositionPredicates.length = 0;
    mockSelect.mockClear();
    currentUser.virtualBalance = '1000.00';
    currentUser.totalDeposited = '1000.00';
    currentUser.totalWithdrawn = '0.00';
    currentUser.lifetimePnL = '0.00';
    storedPositions = [];
  });

  test('calculatePortfolioPnL filters Position.status = active so refunded cancelled positions do not create phantom unrealized profit', async () => {
    // User deposited 1000, bought 100 YES shares at 0.50, and received full
    // refund on market cancel: virtualBalance restored to 1000, cashCostBasis
    // zeroed, status set to 'cancelled', shares kept for history, Market.resolved
    // still false.
    storedPositions = [
      {
        userId: 'user-cancel-1',
        status: 'cancelled',
        resolved: false,
        shares: '100.000000',
        avgPrice: '0.500000',
        cashCostBasis: '0.00',
        side: true,
        marketYesShares: '5000.000000',
        marketNoShares: '5000.000000',
      },
    ];

    const snapshot = await calculatePortfolioPnL('user-cancel-1');

    expect(snapshot).not.toBeNull();
    expect(capturedPositionPredicates).toHaveLength(1);
    const predicate = capturedPositionPredicates[0]!;
    expect(
      extractEqParam(predicate, /(?:"Position"\.)?"status"\s*=\s*\$(\d+)/)
    ).toBe('active');
    expect(
      extractEqParam(predicate, /(?:"Market"\.)?"resolved"\s*=\s*\$(\d+)/)
    ).toBe(false);

    expect(snapshot?.unrealizedPredictionPnL).toBe(0);
    expect(snapshot?.totalUnrealizedPnL).toBe(0);
    expect(snapshot?.totalPnL).toBe(0);
    expect(snapshot?.accountEquity).toBe(1000);
  });

  test('calculatePortfolioBreakdown filters Position.status = active so cancelled positions are not double-counted alongside refunded cash', async () => {
    storedPositions = [
      {
        userId: 'user-cancel-1',
        status: 'cancelled',
        resolved: false,
        shares: '100.000000',
        avgPrice: '0.500000',
        cashCostBasis: '0.00',
        side: true,
        marketYesShares: '5000.000000',
        marketNoShares: '5000.000000',
      },
    ];

    const breakdown = await calculatePortfolioBreakdown('user-cancel-1');

    expect(breakdown).not.toBeNull();
    expect(capturedPositionPredicates).toHaveLength(1);
    const predicate = capturedPositionPredicates[0]!;
    expect(
      extractEqParam(predicate, /(?:"Position"\.)?"status"\s*=\s*\$(\d+)/)
    ).toBe('active');
    expect(
      extractEqParam(predicate, /(?:"Market"\.)?"resolved"\s*=\s*\$(\d+)/)
    ).toBe(false);

    expect(breakdown?.positions).toBe(0);
    expect(breakdown?.totalAssets).toBe(1000);
    expect(breakdown?.totalPnL).toBe(0);
  });

  test('values only active positions when a user also has cancelled or closed rows on unresolved markets', async () => {
    currentUser.virtualBalance = '949.95';
    storedPositions = [
      {
        userId: 'user-cancel-1',
        status: 'cancelled',
        resolved: false,
        shares: '100.000000',
        avgPrice: '0.500000',
        cashCostBasis: '0.00',
        side: true,
        marketYesShares: '5000.000000',
        marketNoShares: '5000.000000',
      },
      {
        userId: 'user-cancel-1',
        status: 'closed',
        resolved: false,
        shares: '25.000000',
        avgPrice: '0.500000',
        cashCostBasis: '0.00',
        side: true,
        marketYesShares: '5000.000000',
        marketNoShares: '5000.000000',
      },
      {
        userId: 'user-cancel-1',
        status: 'active',
        resolved: false,
        shares: '100.000000',
        avgPrice: '0.500000',
        cashCostBasis: '50.05',
        side: true,
        marketYesShares: '5000.000000',
        marketNoShares: '5000.000000',
      },
    ];

    const pnl = await calculatePortfolioPnL('user-cancel-1');
    const breakdown = await calculatePortfolioBreakdown('user-cancel-1');

    expect(pnl?.unrealizedPredictionPnL).toBeCloseTo(-0.05, 6);
    expect(pnl?.totalPnL).toBeCloseTo(-0.05, 6);
    expect(breakdown?.positions).toBeGreaterThan(40);
    expect(breakdown?.positions).toBeLessThan(50);
  });
});

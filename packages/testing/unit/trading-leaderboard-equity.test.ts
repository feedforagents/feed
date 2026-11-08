import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * D-15b equity ranking: the leaderboard rank key is net profit — realized
 * lifetimePnL plus unrealized PnL — not the return ratio and not realized
 * PnL alone. The prediction leg marks positions at the CPMM price but
 * subtracts the remaining gross cash basis (net cost grossed up by the
 * trading fee rate, entry fee included), so the fee already paid in cash
 * is not counted as profit. Keep this aligned with the engine's
 * calculatePortfolioPnL and settlement's remaining cash basis.
 *
 * These tests drive the real service methods with only the database client
 * stubbed (the mocking pattern of
 * trading-performance-date-normalization.test.ts) and inspect the SQL the
 * services actually build, so the ordering rule is pinned on the production
 * query path rather than on a test-only twin helper. The reviewer
 * counterexample (A: +100 realized with -300 unrealized must rank below
 * B: +50 realized, no positions) is exercised end to end at the service
 * level in packages/testing/integration/
 * trading-leaderboard-equity.integration.test.ts against a real
 * PostgreSQL database.
 */

const dialect = new PgDialect();

function renderSql(query: unknown): { text: string; params: unknown[] } {
  const rendered = dialect.sqlToQuery(query as SQL);
  return {
    text: rendered.sql.replace(/\s+/g, ' ').trim(),
    params: rendered.params,
  };
}

interface FixtureRow {
  id: string;
  username: string;
  displayName: string;
  profileImageUrl: null;
  reputationPoints: string;
  balance: string;
  lifetimePnL: string;
  unrealizedPnL: string;
  netProfit: string;
  capitalBase: string;
  effectiveCapitalBase: string;
  tradingReturn: string;
  createdAt: string;
  nftTokenId: null;
  isAgent: boolean;
  managedBy: null;
}

function fixtureRow(
  overrides: Partial<FixtureRow> & { id: string }
): FixtureRow {
  return {
    username: overrides.id,
    displayName: overrides.id,
    profileImageUrl: null,
    reputationPoints: '0',
    balance: '1000',
    lifetimePnL: '0',
    unrealizedPnL: '0',
    netProfit: '0',
    capitalBase: '1000',
    effectiveCapitalBase: '1000',
    tradingReturn: '0',
    createdAt: '2026-01-01T00:00:00.000Z',
    nftTokenId: null,
    isAgent: false,
    managedBy: null,
    ...overrides,
  };
}

// The order the production SQL must produce for these fixtures under the
// D-15b metric: B and C tie at +50 (B created earlier), A nets -200 once
// its open position is marked to market, despite +100 realized.
const rowB = fixtureRow({
  id: 'user-b',
  lifetimePnL: '50',
  unrealizedPnL: '0',
  netProfit: '50',
  createdAt: '2026-01-02T00:00:00.000Z',
});
const rowC = fixtureRow({
  id: 'user-c',
  lifetimePnL: '20',
  unrealizedPnL: '30',
  netProfit: '50',
  createdAt: '2026-01-03T00:00:00.000Z',
});
const rowA = fixtureRow({
  id: 'user-a',
  lifetimePnL: '100',
  unrealizedPnL: '-300',
  netProfit: '-200',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const orderedRows = [rowB, rowC, rowA];
const rowsById = new Map(orderedRows.map((row) => [row.id, row]));

let countAboveResult = 0;

const mockExecute = mock(async (query: unknown) => {
  const { text, params } = renderSql(query);
  if (text.includes('wallet_rows')) {
    return [{ count: countAboveResult }];
  }
  if (text.includes('ORDER BY "netProfit"')) {
    const limit = Number(params[params.length - 2]);
    const offset = Number(params[params.length - 1]);
    return orderedRows.slice(offset, offset + limit);
  }
  const idParam = params.find(
    (param): param is string => typeof param === 'string' && rowsById.has(param)
  );
  const entry = idParam ? rowsById.get(idParam) : undefined;
  return entry ? [entry] : [];
});

const mockSelect = mock(() => ({
  from: () => ({
    where: () => Promise.resolve([{ count: orderedRows.length }]),
  }),
}));

const actualDb = await import('@feed/db');
mock.module('@feed/db', () => ({
  ...actualDb,
  db: {
    execute: mockExecute,
    select: mockSelect,
  },
}));

const performanceModuleUrl = new URL(
  '../../api/src/services/trading-performance-service.ts',
  import.meta.url
);
performanceModuleUrl.searchParams.set('test', 'trading-leaderboard-equity');
const { TradingPerformanceService } = await import(performanceModuleUrl.href);

const leaderboardModuleUrl = new URL(
  '../../api/src/services/trading-leaderboard-service.ts',
  import.meta.url
);
leaderboardModuleUrl.searchParams.set('test', 'trading-leaderboard-equity');
const { TradingLeaderboardService } = await import(leaderboardModuleUrl.href);

const NET_PROFIT_FRAGMENT =
  '( u."lifetimePnL"::numeric + COALESCE(pu."perpUnrealizedPnL", 0)::numeric + COALESCE(du."predictionUnrealizedPnL", 0)::numeric )';

async function captureQueries(
  run: () => Promise<unknown>
): Promise<Array<{ text: string; params: unknown[] }>> {
  mockExecute.mockClear();
  await run();
  return mockExecute.mock.calls.map((call) => renderSql(call[0]));
}

describe('TradingPerformanceService equity metric SQL', () => {
  beforeEach(() => {
    mockExecute.mockClear();
    countAboveResult = 0;
  });

  test('leaderboard rows order by net profit built from realized + unrealized PnL', async () => {
    const [query] = await captureQueries(() =>
      TradingPerformanceService.getWalletLeaderboardRows(100, 0)
    );
    const sqlText = query?.text ?? '';

    // Open perp positions contribute their stored unrealized PnL.
    expect(sqlText).toContain('FROM "PerpPosition" pp');
    expect(sqlText).toContain('pp."closedAt" IS NULL');
    expect(sqlText).toContain('SUM(pp."unrealizedPnL"::numeric)');
    // Prediction positions are marked to market at the CPMM price of
    // unresolved markets, mirroring calculatePortfolioPnL.
    expect(sqlText).toContain('FROM "Position" p');
    expect(sqlText).toContain('JOIN "Market" m ON m."id" = p."marketId"');
    expect(sqlText).toContain('m."resolved" = false');
    expect(sqlText).toContain('m."noShares" / (m."yesShares" + m."noShares")');
    expect(sqlText).toContain('m."yesShares" / (m."yesShares" + m."noShares")');
    // The mark subtracts the remaining GROSS cash basis, not net avgPrice:
    // the entry fee already left the wallet in cash and is not in
    // lifetimePnL until the position closes. The net cost is grossed up by
    // the trading fee rate, rounded to cents.
    expect(sqlText).toContain('p."cashCostBasis"');
    expect(sqlText).toContain('ROUND(');
    expect(sqlText).toContain('(1 - 0.001)');
    expect(sqlText).not.toContain('END - p."avgPrice"');
    // The rank key is the shared net-profit expression, ordered with the
    // established tie-breaks; the return ratio no longer orders the board.
    expect(sqlText).toContain(NET_PROFIT_FRAGMENT);
    expect(sqlText).toContain(
      'ORDER BY "netProfit" DESC, u."createdAt" ASC, u."id" ASC'
    );
    expect(sqlText).not.toContain('ORDER BY "tradingReturn"');
  });

  test('wallet entry selects the same net-profit expression', async () => {
    const [query] = await captureQueries(() =>
      TradingPerformanceService.getWalletEntry('user-a')
    );
    const sqlText = query?.text ?? '';

    expect(sqlText).toContain(NET_PROFIT_FRAGMENT);
    expect(sqlText).toContain('FROM "PerpPosition" pp');
    expect(sqlText).toContain('FROM "Position" p');
    expect(query?.params).toContain('user-a');
  });

  test('countWalletsAbove compares on the identical metric, with no capital input', async () => {
    const [query] = await captureQueries(() =>
      TradingPerformanceService.countWalletsAbove({
        id: 'user-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        netProfit: '-200',
      })
    );
    const sqlText = query?.text ?? '';

    expect(sqlText).toContain(NET_PROFIT_FRAGMENT);
    expect(sqlText).toContain('wr."netProfit" >');
    expect(sqlText).toContain('wr."netProfit" =');
    expect(query?.params).toContain('-200');
    // The count path reads no balance or capital data at all, so a
    // purchase (a balance transaction plus a balance bump) cannot change
    // anyone's counted rank.
    expect(sqlText).not.toContain('BalanceTransaction');
    expect(sqlText).not.toContain('capitalBase');
    expect(sqlText).not.toContain('virtualBalance');
  });

  test('the net-profit fragment itself reads no purchase-sensitive input', async () => {
    const [query] = await captureQueries(() =>
      TradingPerformanceService.getWalletLeaderboardRows(100, 0)
    );
    const sqlText = query?.text ?? '';
    const fragmentStart = sqlText.indexOf(NET_PROFIT_FRAGMENT);
    expect(fragmentStart).toBeGreaterThanOrEqual(0);
    const fragment = sqlText.slice(
      fragmentStart,
      fragmentStart + NET_PROFIT_FRAGMENT.length
    );
    expect(fragment).not.toContain('BalanceTransaction');
    expect(fragment).not.toContain('capitalBase');
    expect(fragment).not.toContain('virtualBalance');
  });
});

describe('TradingLeaderboardService equity ranking behavior', () => {
  beforeEach(() => {
    mockExecute.mockClear();
    countAboveResult = 0;
  });

  test('entries expose net profit and rank by it, not by realized PnL', async () => {
    const result = await TradingLeaderboardService.getWalletLeaderboard(1, 100);

    expect(result.totalCount).toBe(3);
    expect(result.users.map((user) => user.id)).toEqual([
      'user-b',
      'user-c',
      'user-a',
    ]);
    expect(result.users.map((user) => user.rank)).toEqual([1, 2, 3]);
    // A realized +100 but nets -200 with its open position marked to
    // market, so it ranks below B's +50 — the D-15b ordering.
    const entryA = result.users[2];
    expect(entryA?.lifetimePnL).toBe(100);
    expect(entryA?.unrealizedPnL).toBe(-300);
    expect(entryA?.netProfit).toBe(-200);
    // Return % is still carried alongside as the display metric.
    expect(entryA?.tradingReturn).toBe(0);
  });

  test('pagination slices keep the global rank', async () => {
    const page2 = await TradingLeaderboardService.getWalletLeaderboard(2, 2);
    expect(page2.users).toHaveLength(1);
    expect(page2.users[0]?.id).toBe('user-a');
    expect(page2.users[0]?.rank).toBe(3);
    expect(page2.totalPages).toBe(2);
  });

  test('own position rank agrees with the leaderboard order', async () => {
    countAboveResult = 2;
    const position = await TradingLeaderboardService.getUserPosition(
      'user-a',
      'wallet'
    );
    expect(position?.rank).toBe(3);
    expect(position?.entry.id).toBe('user-a');
    expect(position?.entry.netProfit).toBe(-200);

    countAboveResult = 1;
    const tiedPosition = await TradingLeaderboardService.getUserPosition(
      'user-c',
      'wallet'
    );
    // C ties B on net profit but was created later, so exactly one wallet
    // counts above it.
    expect(tiedPosition?.rank).toBe(2);
  });
});

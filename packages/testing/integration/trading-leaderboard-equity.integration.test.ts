/**
 * Integration Tests: Trading Leaderboard Equity Ranking (PRD §9.4, D-15b)
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied. Every test returns early when no database is reachable, the
 * convention of this directory.
 *
 * D-15b ranks the trading leaderboard by net profit — current equity minus
 * the starting grant and points purchased — which the portfolio stack
 * defines as totalPnL: realized lifetimePnL plus unrealized PnL marked to
 * market (see calculatePortfolioPnL in packages/engine). These tests run
 * the real TradingPerformanceService / TradingLeaderboardService queries
 * against PostgreSQL and pin the behaviors the metric definition implies:
 * open positions move rank before they close, closing a position does not
 * by itself, and buying points never does.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  TradingLeaderboardService,
  TradingPerformanceService,
} from '@feed/api';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  perpPositions,
  positions,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(30000);

let dbAvailable = false;
const testUserIds: string[] = [];
const testMarketIds: string[] = [];

async function checkDatabaseHealth(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;

  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

async function createTestUser(params: {
  usernamePrefix: string;
  lifetimePnL: number;
  createdAt: Date;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-${id}`,
    username: `${params.usernamePrefix}-${id}`,
    displayName: params.usernamePrefix,
    virtualBalance: '1000',
    totalDeposited: '1000',
    totalWithdrawn: '0',
    lifetimePnL: params.lifetimePnL.toFixed(2),
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    createdAt: params.createdAt,
    updatedAt: new Date(),
  });
  testUserIds.push(id);
  return id;
}

async function createOpenPerpPosition(params: {
  userId: string;
  unrealizedPnL: number;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(perpPositions).values({
    id,
    userId: params.userId,
    ticker: 'TEST',
    organizationId: 'test-org',
    side: 'long',
    entryPrice: 100,
    currentPrice: 100,
    size: 500,
    leverage: 1,
    liquidationPrice: 0,
    unrealizedPnL: params.unrealizedPnL,
    unrealizedPnLPercent: 0,
    lastUpdated: new Date(),
    closedAt: null,
  });
  return id;
}

async function createMarket(params: {
  yesShares: number;
  noShares: number;
  resolved: boolean;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(markets).values({
    id,
    question: `leaderboard-equity-${id}`,
    liquidity: '1000',
    yesShares: params.yesShares.toFixed(6),
    noShares: params.noShares.toFixed(6),
    resolved: params.resolved,
    endDate: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
  });
  testMarketIds.push(id);
  return id;
}

async function createPredictionPosition(params: {
  userId: string;
  marketId: string;
  side: boolean;
  shares: number;
  avgPrice: number;
}): Promise<void> {
  await db.insert(positions).values({
    id: await generateSnowflakeId(),
    userId: params.userId,
    marketId: params.marketId,
    side: params.side,
    shares: params.shares.toFixed(6),
    avgPrice: params.avgPrice.toFixed(6),
    amount: (params.shares * params.avgPrice).toFixed(2),
    status: 'active',
    updatedAt: new Date(),
  });
}

/** Seeded users in leaderboard order, ignoring any pre-existing rows. */
async function seededOrder(): Promise<string[]> {
  const rows = await TradingPerformanceService.getWalletLeaderboardRows(
    10000,
    0
  );
  return rows.map((row) => row.id).filter((id) => testUserIds.includes(id));
}

beforeAll(async () => {
  dbAvailable = await checkDatabaseHealth();
});

afterAll(async () => {
  if (!dbAvailable || testUserIds.length === 0) return;
  await db.delete(positions).where(inArray(positions.userId, testUserIds));
  await db
    .delete(perpPositions)
    .where(inArray(perpPositions.userId, testUserIds));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, testUserIds));
  if (testMarketIds.length > 0) {
    await db.delete(markets).where(inArray(markets.id, testMarketIds));
  }
  await db.delete(users).where(inArray(users.id, testUserIds));
});

describe('Trading leaderboard equity ranking (D-15b)', () => {
  test('ranks by net profit including unrealized PnL, not realized PnL alone', async () => {
    if (!dbAvailable) return;

    // The review counterexample on PR #1565: equal 1,000 starting capital,
    // no purchases. A realized +100 but holds an open position at -300
    // unrealized (net profit -200); B realized +50 with no positions.
    const userA = await createTestUser({
      usernamePrefix: 'lb-eq-a',
      lifetimePnL: 100,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createOpenPerpPosition({ userId: userA, unrealizedPnL: -300 });
    const userB = await createTestUser({
      usernamePrefix: 'lb-eq-b',
      lifetimePnL: 50,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    const entryA = await TradingPerformanceService.getWalletEntry(userA);
    expect(entryA).not.toBeNull();
    expect(Number(entryA?.unrealizedPnL)).toBe(-300);
    expect(Number(entryA?.netProfit)).toBe(-200);

    const order = await seededOrder();
    expect(order.indexOf(userB)).toBeLessThan(order.indexOf(userA));
  });

  test('marks prediction positions to market; resolved markets contribute nothing', async () => {
    if (!dbAvailable) return;

    const user = await createTestUser({
      usernamePrefix: 'lb-eq-pred',
      lifetimePnL: 0,
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    // CPMM yes price = noShares / (yesShares + noShares) = 300/400 = 0.75.
    // 100 shares bought at 0.5 are worth +25 unrealized.
    const openMarket = await createMarket({
      yesShares: 100,
      noShares: 300,
      resolved: false,
    });
    await createPredictionPosition({
      userId: user,
      marketId: openMarket,
      side: true,
      shares: 100,
      avgPrice: 0.5,
    });
    // The same position in a resolved market is settled, not unrealized.
    const resolvedMarket = await createMarket({
      yesShares: 100,
      noShares: 300,
      resolved: true,
    });
    await createPredictionPosition({
      userId: user,
      marketId: resolvedMarket,
      side: true,
      shares: 100,
      avgPrice: 0.5,
    });

    const entry = await TradingPerformanceService.getWalletEntry(user);
    expect(Number(entry?.unrealizedPnL)).toBe(25);
    expect(Number(entry?.netProfit)).toBe(25);
  });

  test('buying points changes neither net profit nor rank', async () => {
    if (!dbAvailable) return;

    const buyer = await createTestUser({
      usernamePrefix: 'lb-eq-buyer',
      lifetimePnL: 50,
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    const rival = await createTestUser({
      usernamePrefix: 'lb-eq-rival',
      lifetimePnL: 100,
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    });

    const orderBefore = await seededOrder();
    const buyerEntryBefore =
      await TradingPerformanceService.getWalletEntry(buyer);
    expect(Number(buyerEntryBefore?.netProfit)).toBe(50);

    // A real points purchase: an external-funding balance transaction and
    // the matching balance / totalDeposited increase.
    await db.insert(balanceTransactions).values({
      id: await generateSnowflakeId(),
      userId: buyer,
      type: 'stripe_purchase',
      amount: '9000',
      balanceBefore: '1000',
      balanceAfter: '10000',
      description: 'integration seed purchase',
    });
    await db
      .update(users)
      .set({ virtualBalance: '10000', totalDeposited: '10000' })
      .where(eq(users.id, buyer));

    const buyerEntryAfter =
      await TradingPerformanceService.getWalletEntry(buyer);
    expect(Number(buyerEntryAfter?.netProfit)).toBe(50);

    const orderAfter = await seededOrder();
    expect(orderAfter.indexOf(buyer)).toBe(orderBefore.indexOf(buyer));
    expect(orderAfter.indexOf(rival)).toBe(orderBefore.indexOf(rival));
  });

  test('closing a position does not by itself change net profit', async () => {
    if (!dbAvailable) return;

    const user = await createTestUser({
      usernamePrefix: 'lb-eq-close',
      lifetimePnL: 100,
      createdAt: new Date('2026-01-06T00:00:00.000Z'),
    });
    const positionId = await createOpenPerpPosition({
      userId: user,
      unrealizedPnL: -300,
    });

    const before = await TradingPerformanceService.getWalletEntry(user);
    expect(Number(before?.netProfit)).toBe(-200);

    // Close: the -300 moves from unrealized into realized lifetimePnL.
    await db
      .update(perpPositions)
      .set({ closedAt: new Date(), realizedPnL: -300 })
      .where(eq(perpPositions.id, positionId));
    await db
      .update(users)
      .set({ lifetimePnL: '-200' })
      .where(eq(users.id, user));

    const after = await TradingPerformanceService.getWalletEntry(user);
    expect(Number(after?.unrealizedPnL)).toBe(0);
    expect(Number(after?.netProfit)).toBe(-200);
  });

  test('ties break by createdAt, and own rank agrees with the full ordering', async () => {
    if (!dbAvailable) return;

    const earlier = await createTestUser({
      usernamePrefix: 'lb-eq-tie-early',
      lifetimePnL: 777,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    const later = await createTestUser({
      usernamePrefix: 'lb-eq-tie-late',
      lifetimePnL: 777,
      createdAt: new Date('2026-02-02T00:00:00.000Z'),
    });

    const order = await seededOrder();
    expect(order.indexOf(earlier)).toBeLessThan(order.indexOf(later));

    const allRows = await TradingPerformanceService.getWalletLeaderboardRows(
      10000,
      0
    );
    for (const userId of [earlier, later]) {
      const scanIndex = allRows.findIndex((row) => row.id === userId);
      expect(scanIndex).toBeGreaterThanOrEqual(0);
      const position = await TradingLeaderboardService.getUserPosition(
        userId,
        'wallet',
        2
      );
      expect(position?.rank).toBe(scanIndex + 1);
      expect(position?.page).toBe(Math.ceil((scanIndex + 1) / 2));
      expect(position?.entry.netProfit).toBe(777);
    }
  });
});

/**
 * Integration Tests: Portfolio PnL prediction cost basis (PRD §9.2, D-14)
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied. Every test returns early when no database is reachable, the
 * convention of this directory.
 *
 * The engine's calculatePortfolioPnL marked open prediction positions at
 * `shares * (currentPrice - avgPrice)`. Position.avgPrice is net of the
 * entry fee, while the fee already left the wallet in cash and is not in
 * lifetimePnL until the position closes — so the fee was counted as
 * profit, and the portfolio total disagreed with the trading leaderboard,
 * which already subtracts the remaining gross cash basis. These tests run
 * the real calculatePortfolioPnL against PostgreSQL and pin the
 * reconciliation: unrealized prediction PnL is mark value minus the
 * persisted cashCostBasis (legacy rows without one use the net-cost
 * gross-up estimate).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { db, eq, inArray, markets, positions, sql, users } from '@feed/db';
import { calculatePortfolioPnL } from '@feed/engine/services/portfolio-pnl';
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

async function createMarket(params: {
  yesShares: number;
  noShares: number;
}): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(markets).values({
    id,
    question: `portfolio-pnl-cost-basis-${id}`,
    liquidity: '1000',
    yesShares: params.yesShares.toFixed(6),
    noShares: params.noShares.toFixed(6),
    resolved: false,
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
  cashCostBasis: number | null;
}): Promise<void> {
  await db.insert(positions).values({
    id: await generateSnowflakeId(),
    userId: params.userId,
    marketId: params.marketId,
    side: params.side,
    shares: params.shares.toFixed(6),
    avgPrice: params.avgPrice.toFixed(6),
    cashCostBasis:
      params.cashCostBasis === null ? null : params.cashCostBasis.toFixed(2),
    amount: (params.shares * params.avgPrice).toFixed(2),
    status: 'active',
    updatedAt: new Date(),
  });
}

async function setMarketShares(
  marketId: string,
  yesShares: number,
  noShares: number
): Promise<void> {
  await db
    .update(markets)
    .set({
      yesShares: yesShares.toFixed(6),
      noShares: noShares.toFixed(6),
    })
    .where(eq(markets.id, marketId));
}

beforeAll(async () => {
  dbAvailable = await checkDatabaseHealth();
});

afterAll(async () => {
  if (!dbAvailable || testUserIds.length === 0) return;
  await db.delete(positions).where(inArray(positions.userId, testUserIds));
  if (testMarketIds.length > 0) {
    await db.delete(markets).where(inArray(markets.id, testMarketIds));
  }
  await db.delete(users).where(inArray(users.id, testUserIds));
});

describe('Portfolio PnL prediction cost basis', () => {
  test('marks an open prediction position against gross cash cost, not net avgPrice', async () => {
    if (!dbAvailable) return;

    const user = await createTestUser({
      usernamePrefix: 'pf-pnl-gross',
      lifetimePnL: 0,
      createdAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    // YES price = noShares / (yesShares + noShares) = 0.50.
    // 100 shares at net avgPrice 0.50 cost 50.00 net; the gross cash paid
    // was 50.05 (0.1% entry fee). The old formula reported unrealized PnL
    // 100 * (0.50 - 0.50) = 0 and counted the 0.05 fee as profit.
    const market = await createMarket({ yesShares: 5000, noShares: 5000 });
    await createPredictionPosition({
      userId: user,
      marketId: market,
      side: true,
      shares: 100,
      avgPrice: 0.5,
      cashCostBasis: 50.05,
    });

    const snapshot = await calculatePortfolioPnL(user);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.unrealizedPredictionPnL).toBeCloseTo(-0.05, 6);
    expect(snapshot?.totalPnL).toBeCloseTo(-0.05, 6);

    // Move the YES price to 0.60: mark value 60.00, gross basis 50.05.
    await setMarketShares(market, 4000, 6000);
    const moved = await calculatePortfolioPnL(user);
    expect(moved).not.toBeNull();
    expect(moved?.unrealizedPredictionPnL).toBeCloseTo(9.95, 6);
    expect(moved?.totalPnL).toBeCloseTo(9.95, 6);
  });

  test('falls back to the gross-up estimate for legacy rows without cashCostBasis', async () => {
    if (!dbAvailable) return;

    const user = await createTestUser({
      usernamePrefix: 'pf-pnl-legacy',
      lifetimePnL: 0,
      createdAt: new Date('2026-01-05T00:00:00.000Z'),
    });
    const market = await createMarket({ yesShares: 5000, noShares: 5000 });
    await createPredictionPosition({
      userId: user,
      marketId: market,
      side: true,
      shares: 100,
      avgPrice: 0.5,
      cashCostBasis: null,
    });

    // Legacy fallback: ROUND(50.00 / (1 - 0.001), 2) = 50.05.
    const snapshot = await calculatePortfolioPnL(user);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.unrealizedPredictionPnL).toBeCloseTo(-0.05, 6);
    expect(snapshot?.totalPnL).toBeCloseTo(-0.05, 6);
  });
});

/**
 * Integration Tests: Portfolio PnL prediction cost basis (PRD §9.2, D-14)
 *
 * Requires DATABASE_URL pointing at a disposable database with schema
 * applied. Database unavailability fails the suite rather than reporting
 * unexecuted assertions as passing tests.
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
import { TradingPerformanceService } from '@feed/api';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  sql,
  users,
} from '@feed/db';
import { FEE_CONFIG, withPredictionSettlement } from '@feed/engine';
import { calculatePortfolioPnL } from '@feed/engine/services/portfolio-pnl';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(30000);

const testUserIds: string[] = [];
const testMarketIds: string[] = [];

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
  await db.execute(sql`SELECT 1`);
});

afterAll(async () => {
  if (testUserIds.length === 0) return;
  await db.delete(positions).where(inArray(positions.userId, testUserIds));
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.userId, testUserIds));
  await db
    .delete(pointsTransactions)
    .where(inArray(pointsTransactions.userId, testUserIds));
  if (testMarketIds.length > 0) {
    await db
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, testMarketIds));
    await db.delete(markets).where(inArray(markets.id, testMarketIds));
  }
  await db.delete(users).where(inArray(users.id, testUserIds));
});

describe('Portfolio PnL prediction cost basis', () => {
  test('marks an open prediction position against gross cash cost, not net avgPrice', async () => {
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

const settlementOptions = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};

for (const side of ['yes', 'no'] as const) {
  for (const legacy of [false, true]) {
    test(`${side} ${legacy ? 'legacy' : 'stored'} funded holdings reconcile after repeated partial sells and full close`, async () => {
      const userId = await createTestUser({
        usernamePrefix: 'pf-pnl-funded',
        lifetimePnL: 0,
        createdAt: new Date(),
      });
      await db
        .update(users)
        .set({ virtualBalance: '2000', totalDeposited: '2000' })
        .where(eq(users.id, userId));
      const marketId = await createMarket({ yesShares: 5000, noShares: 5000 });
      const trade = <T>(
        operation: Parameters<typeof withPredictionSettlement<T>>[2]
      ) =>
        withPredictionSettlement(
          marketId,
          { userId },
          operation,
          settlementOptions
        );
      const buy = await trade((service) =>
        service.buy({ userId, marketId, side, amount: 1000 })
      );
      if (legacy)
        await db
          .update(positions)
          .set({ cashCostBasis: null })
          .where(eq(positions.id, buy.positionId));
      async function reconcile() {
        const [position] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, buy.positionId));
        const [market] = await db
          .select()
          .from(markets)
          .where(eq(markets.id, marketId));
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(position).toBeDefined();
        expect(market).toBeDefined();
        expect(user).toBeDefined();
        const price =
          Number(side === 'yes' ? market!.noShares : market!.yesShares) /
          (Number(market!.yesShares) + Number(market!.noShares));
        const markedValue = Number(position!.shares) * price;
        const snapshot = await calculatePortfolioPnL(userId);
        const leaderboard =
          await TradingPerformanceService.getWalletEntry(userId);
        expect(snapshot).not.toBeNull();
        expect(leaderboard).not.toBeNull();
        expect(snapshot!.accountEquity).toBeCloseTo(
          Number(user!.virtualBalance) + markedValue,
          6
        );
        expect(snapshot!.totalPnL).toBeCloseTo(
          Number(user!.virtualBalance) + markedValue - 2000,
          6
        );
        expect(snapshot!.totalPnL).toBeCloseTo(
          Number(leaderboard!.netProfit),
          6
        );
        return position!;
      }
      await reconcile();
      for (const shares of [100, 200]) {
        await trade((service) =>
          service.sell({ userId, marketId, positionId: buy.positionId, shares })
        );
        await reconcile();
      }
      const [remaining] = await db
        .select()
        .from(positions)
        .where(eq(positions.id, buy.positionId));
      await trade((service) =>
        service.sell({
          userId,
          marketId,
          positionId: buy.positionId,
          shares: Number(remaining!.shares),
        })
      );
      const closed = await reconcile();
      expect(closed.status).toBe('closed');
      expect(Number(closed.cashCostBasis)).toBe(0);
    });
  }
}

test('legacy half-cent fallback matches the settlement service rather than binary Math.round', async () => {
  const userId = await createTestUser({
    usernamePrefix: 'pf-pnl-half-cent',
    lifetimePnL: 0,
    createdAt: new Date(),
  });
  const marketId = await createMarket({ yesShares: 5000, noShares: 5000 });
  await createPredictionPosition({
    userId,
    marketId,
    side: true,
    shares: 3,
    avgPrice: 0.334665,
    cashCostBasis: null,
  });
  const snapshot = await calculatePortfolioPnL(userId);
  const result = await withPredictionSettlement(
    marketId,
    { system: 'synthetic_legacy_basis_regression' },
    (service) => service.cancel({ marketId }),
    settlementOptions
  );
  expect(result.totalRefunded).toBe(1.01);
  expect(snapshot?.unrealizedPredictionPnL).toBeCloseTo(
    1.5 - result.totalRefunded,
    8
  );
});

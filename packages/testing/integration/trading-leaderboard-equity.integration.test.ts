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
import { TradingLeaderboardService } from '@feed/api/services/trading-leaderboard-service';
import { TradingPerformanceService } from '@feed/api/services/trading-performance-service';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  and,
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
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { withPredictionSettlement } from '@feed/engine/services/prediction-settlement';
import { WalletService } from '@feed/engine/services/wallet-service';
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

/** Real trade service wired to the production wallet (balance + lifetimePnL). */
function realTradeService(): PredictionMarketService {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.debit(
          userId,
          amount,
          reason,
          description ?? '',
          relatedId
        ),
      credit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.credit(
          userId,
          amount,
          reason,
          description ?? '',
          relatedId
        ),
      recordPnL: ({ userId, pnl, reason, relatedId }) =>
        WalletService.recordPnL(userId, pnl, reason, relatedId).then(
          () => undefined
        ),
      getBalance: (userId) => WalletService.getBalance(userId),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });
}

async function readPredictionState(userId: string, marketId: string) {
  const [userRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [marketRow] = await db
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);
  const [positionRow] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.marketId, marketId)))
    .limit(1);
  return { userRow, marketRow, positionRow };
}

/**
 * The equity profit of an open prediction position, computed from the stored
 * rows the way the leaderboard query defines it: mark value (shares x CPMM
 * probability) minus the remaining gross cash basis (net cost grossed up by
 * the fee rate), plus realized lifetimePnL. The old formula is the same
 * expression with the net cost instead of the gross basis.
 */
function equityProfitFromState(state: {
  userRow?: typeof users.$inferSelect;
  marketRow?: typeof markets.$inferSelect;
  positionRow?: typeof positions.$inferSelect;
}) {
  const { userRow, marketRow, positionRow } = state;
  if (!userRow || !marketRow || !positionRow) {
    throw new Error('missing prediction state');
  }
  const shares = Number(positionRow.shares);
  const yesShares = Number(marketRow.yesShares);
  const noShares = Number(marketRow.noShares);
  const markPrice =
    yesShares + noShares > 0
      ? positionRow.side
        ? noShares / (yesShares + noShares)
        : yesShares / (yesShares + noShares)
      : Number(positionRow.avgPrice);
  const markValue = shares * markPrice;
  const netCost = shares * Number(positionRow.avgPrice);
  const grossBasis =
    positionRow.cashCostBasis === null
      ? Math.round((netCost / (1 - FEE_CONFIG.TRADING_FEE_RATE)) * 100) / 100
      : Number(positionRow.cashCostBasis);
  const lifetimePnL = Number(userRow.lifetimePnL);
  const cash = Number(userRow.virtualBalance);
  const contributions =
    Number(userRow.totalDeposited) - Number(userRow.totalWithdrawn);
  return {
    markValue,
    grossBasis,
    netCost,
    expectedNetProfit: lifetimePnL + (markValue - grossBasis),
    expectedEquityProfit: cash + markValue - contributions,
    oldFormulaNetProfit: lifetimePnL + (markValue - netCost),
  };
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
    // The mark subtracts the remaining gross cash basis: the net cost
    // 100 x 0.5 is grossed up by the fee rate, 50 / (1 - 0.001) = 50.05,
    // and 75 - 50.05 = 24.95. The 0.05 is the entry fee the old
    // net-avgPrice formula counted as profit.
    expect(Number(entry?.unrealizedPnL)).toBeCloseTo(24.95, 2);
    expect(Number(entry?.netProfit)).toBeCloseTo(24.95, 2);
  });

  test('entry fee is not counted as profit on a real buy and partial exit', async () => {
    if (!dbAvailable) return;

    // The SYMBaiEX counterexample on #1565, replayed with real trades: a
    // 100-point buy must rank by equity profit (cash + mark value -
    // contributions), not by the mark minus net avgPrice, which counts the
    // entry fee as profit.
    const buyer = await createTestUser({
      usernamePrefix: 'lb-eq-fee',
      lifetimePnL: 0,
      createdAt: new Date('2026-01-07T00:00:00.000Z'),
    });
    // Thin skewed market (YES 0.20): the buy moves the price, like the
    // reviewer's market, so the mark value is near the amount spent.
    const marketId = await createMarket({
      yesShares: 400,
      noShares: 100,
      resolved: false,
    });
    const trades = realTradeService();

    const buy = await trades.buy({
      userId: buyer,
      marketId,
      side: 'yes',
      amount: 100,
      maxOddsMove: 0.5,
    });
    expect(buy.feePaid).toBeCloseTo(0.1, 2);

    const buyState = equityProfitFromState(
      await readPredictionState(buyer, marketId)
    );
    // The gross basis is the cash paid, including the fee.
    expect(buyState.grossBasis).toBeCloseTo(100, 2);
    expect(buyState.netCost).toBeCloseTo(99.9, 2);

    const entryAfterBuy = await TradingPerformanceService.getWalletEntry(buyer);
    expect(Number(entryAfterBuy?.netProfit)).toBeCloseTo(
      buyState.expectedNetProfit,
      2
    );
    expect(Number(entryAfterBuy?.netProfit)).toBeCloseTo(
      buyState.expectedEquityProfit,
      2
    );
    // The old net-avgPrice formula overstated by the entry fee.
    expect(
      buyState.oldFormulaNetProfit - Number(entryAfterBuy?.netProfit)
    ).toBeCloseTo(0.1, 1);

    // A control sitting between the true and the overstated profit ranks
    // above the buyer only when the fee is excluded.
    const control = await createTestUser({
      usernamePrefix: 'lb-eq-fee-control',
      lifetimePnL:
        (buyState.expectedNetProfit + buyState.oldFormulaNetProfit) / 2,
      createdAt: new Date('2026-01-08T00:00:00.000Z'),
    });
    const orderAfterBuy = await seededOrder();
    expect(orderAfterBuy.indexOf(control)).toBeLessThan(
      orderAfterBuy.indexOf(buyer)
    );

    // Sell half: the sold half's fee is realized into lifetimePnL, the
    // remaining half's fee must stay out of unrealized PnL.
    await trades.sell({
      userId: buyer,
      marketId,
      shares: buy.shares / 2,
    });

    const sellState = equityProfitFromState(
      await readPredictionState(buyer, marketId)
    );
    const entryAfterSell =
      await TradingPerformanceService.getWalletEntry(buyer);
    expect(Number(entryAfterSell?.netProfit)).toBeCloseTo(
      sellState.expectedNetProfit,
      2
    );
    expect(Number(entryAfterSell?.netProfit)).toBeCloseTo(
      sellState.expectedEquityProfit,
      2
    );
    // Only the remaining half's fee is still unrecognized.
    expect(
      sellState.oldFormulaNetProfit - Number(entryAfterSell?.netProfit)
    ).toBeCloseTo(0.05, 1);
  });

  test('keeps the recorded cash basis after repeated partial sales', async () => {
    if (!dbAvailable) return;

    const buyer = await createTestUser({
      usernamePrefix: 'lb-eq-rounded-basis',
      lifetimePnL: 0,
      createdAt: new Date('2026-01-09T00:00:00.000Z'),
    });
    const marketId = await createMarket({
      yesShares: 10000,
      noShares: 10000,
      resolved: false,
    });
    const options = {
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    };
    await withPredictionSettlement(
      marketId,
      { userId: buyer },
      (service) =>
        service.buy({ userId: buyer, marketId, side: 'yes', amount: 10 }),
      options
    );
    for (let sale = 0; sale < 2; sale++) {
      const { positionRow } = await readPredictionState(buyer, marketId);
      if (!positionRow) throw new Error('Expected an open prediction position');
      await withPredictionSettlement(
        marketId,
        { userId: buyer },
        (service) =>
          service.sell({
            userId: buyer,
            marketId,
            shares: Number(positionRow.shares) / 3,
          }),
        options
      );
    }
    const state = await readPredictionState(buyer, marketId);
    expect(Number(state.positionRow?.cashCostBasis)).toBe(4.45);
    const equity = equityProfitFromState(state);
    const entry = await TradingPerformanceService.getWalletEntry(buyer);
    expect(Number(entry?.netProfit)).toBeCloseTo(
      equity.expectedEquityProfit,
      8
    );

    // The control sits a hair above the buyer's true equity profit
    // (≈ -0.0102). Both partial sales are small enough that their fees
    // round to zero under the canonical cent-rounded fee, so the buyer
    // realizes no fee loss on them; the control is calibrated to that
    // post-fee profit, keeping the same hair-thin gap this assertion
    // was written against.
    const control = await createTestUser({
      usernamePrefix: 'lb-eq-rounded-control',
      lifetimePnL: -0.01,
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
    });
    await db
      .update(users)
      .set({ virtualBalance: '999.99' })
      .where(eq(users.id, control));
    const order = await seededOrder();
    expect(order.indexOf(control)).toBeLessThan(order.indexOf(buyer));
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

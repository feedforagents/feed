/**
 * Trade-count achievements must count trades, not position rows.
 *
 * Repeated prediction buys on one market/side merge into a single position
 * row (upsert), and perp adds merge into the open position row, while the
 * wallet ledger records one row per executed trade. The achievements list
 * (GET /api/achievements -> getUserAchievements) and the unlock checks both
 * read ACHIEVEMENT_RESOLVERS, so a user who completed 12 trades on one
 * market and one ticker must see "Active Trader" (10 trades) unlocked —
 * not progress 2/10 from the two position rows.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { checkProgress, getUserAchievements } from '@feed/api';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  balanceTransactions,
  db,
  eq,
  markets,
  notifications,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  positions,
  userAchievements,
  userChallengeProgress,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { WalletService } from '@feed/engine/services/wallet-service';
import { generateSnowflakeId } from '@feed/shared';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';

function makePredictionService() {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: ({ userId: u, amount, reason, description, relatedId }) =>
        WalletService.debit(u, amount, reason, description ?? '', relatedId),
      credit: ({ userId: u, amount, reason, description, relatedId }) =>
        WalletService.credit(u, amount, reason, description ?? '', relatedId),
      recordPnL: async ({ userId: u, pnl, reason, relatedId }) => {
        await WalletService.recordPnL(u, pnl, reason, relatedId);
      },
      getBalance: (uid: string) => WalletService.getBalance(uid),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });
}

async function makeUser(tag: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:f90-${tag}-${id}`,
    username: `f90-${tag}-${id.slice(-10)}`,
    displayName: `f90-${tag}`,
    virtualBalance: '100000',
    totalDeposited: '100000',
    totalWithdrawn: '0',
    lifetimePnL: '0',
    reputationPoints: 0,
    isActor: false,
    isAgent: false,
    profileComplete: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function makeMarket(tag: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(markets).values({
    id,
    question: `f90-${tag}-${id}`,
    liquidity: '10000',
    yesShares: '5000',
    noShares: '5000',
    resolved: false,
    endDate: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
  });
  return id;
}

async function cleanupUser(userId: string) {
  await db.delete(notifications).where(eq(notifications.userId, userId));
  await db.delete(userAchievements).where(eq(userAchievements.userId, userId));
  await db
    .delete(userChallengeProgress)
    .where(eq(userChallengeProgress.userId, userId));
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(positions).where(eq(positions.userId, userId));
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('achievement trade-count progress', () => {
  let heavyUserId: string;
  let lightUserId: string;
  let heavyMarketId: string;
  let lightMarketId: string;
  let ticker: string;

  beforeAll(async () => {
    const prediction = makePredictionService();

    // Heavy user: 10 prediction buys on ONE market/side + perp open + add
    // on ONE ticker = 12 executed trades, but only 2 position rows.
    heavyUserId = await makeUser('heavy');
    heavyMarketId = await makeMarket('heavy');
    for (let i = 0; i < 10; i++) {
      await prediction.buy({
        userId: heavyUserId,
        marketId: heavyMarketId,
        side: 'yes',
        amount: 10,
      });
      // The buy route fires this per trade.
      await checkProgress(heavyUserId, {
        type: 'prediction_trade',
        marketId: heavyMarketId,
      });
    }

    ticker = `F90${heavyUserId.slice(-6).toUpperCase()}`;
    await db.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await db.insert(perpMarketSnapshots).values({
      ticker,
      organizationId: ticker,
      currentPrice: 100,
      high24h: 100,
      low24h: 100,
      openInterest: 0,
      volume24h: 0,
      fundingRate: {
        ticker,
        rate: 0,
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0,
      },
    });
    const perps = createPerpMarketService();
    await perps.openPosition({
      userId: heavyUserId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 10,
    });
    await checkProgress(heavyUserId, { type: 'perp_trade', ticker });
    // Second open on the same ticker/side is an add: a second trade that
    // merges into the same position row.
    await perps.openPosition({
      userId: heavyUserId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    });
    await checkProgress(heavyUserId, { type: 'perp_trade', ticker });

    // Light user: 3 prediction buys on one market = 3 trades, 1 row.
    lightUserId = await makeUser('light');
    lightMarketId = await makeMarket('light');
    for (let i = 0; i < 3; i++) {
      await prediction.buy({
        userId: lightUserId,
        marketId: lightMarketId,
        side: 'yes',
        amount: 10,
      });
    }
  });

  afterAll(async () => {
    await cleanupUser(heavyUserId);
    await cleanupUser(lightUserId);
    await db.delete(markets).where(eq(markets.id, heavyMarketId));
    await db.delete(markets).where(eq(markets.id, lightMarketId));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await db.delete(organizationState).where(eq(organizationState.id, ticker));
  });

  it('premise: the ledger records every trade while position rows merge', async () => {
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, heavyUserId));
    const byType = new Map<string, number>();
    for (const r of ledger) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    expect(byType.get('pred_buy')).toBe(10);
    expect(byType.get('perp_open')).toBe(1);
    expect(byType.get('perp_add_to_position')).toBe(1);

    const predRows = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, heavyUserId));
    const perpRows = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, heavyUserId));
    expect(predRows).toHaveLength(1);
    expect(perpRows).toHaveLength(1);
  });

  it('shows Active Trader unlocked after 12 trades on one market and one ticker', async () => {
    const list = await getUserAchievements(heavyUserId);
    const tenTrades = list.find((a) => a.id === 'ten_trades');
    expect(tenTrades).toBeDefined();
    expect(tenTrades!.unlocked).toBe(true);
    expect(tenTrades!.progress).toBe(10); // capped at threshold

    const firstPred = list.find((a) => a.id === 'first_prediction_trade');
    expect(firstPred!.unlocked).toBe(true);
    const firstPerp = list.find((a) => a.id === 'first_perp_trade');
    expect(firstPerp!.unlocked).toBe(true);
  });

  it('shows the real trade count as progress below the threshold', async () => {
    const list = await getUserAchievements(lightUserId);
    const tenTrades = list.find((a) => a.id === 'ten_trades');
    expect(tenTrades).toBeDefined();
    expect(tenTrades!.unlocked).toBe(false);
    expect(tenTrades!.progress).toBe(3);
  });
});

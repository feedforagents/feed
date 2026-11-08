/**
 * Trade-challenge progress must count trades, not position rows.
 *
 * The daily/weekly trade challenges ("Place 2 trades (any type)",
 * "Place 5 prediction trades", "Complete 10 trades", "Place a prediction
 * AND a perp trade") read CHALLENGE_RESOLVERS in achievement-service.
 * Those resolvers counted position rows created/opened inside the
 * window: repeated buys on one market/side merge into a single position
 * row (upsert) and perp adds merge into the open position row, so a user
 * who traded 6 times today on a market opened yesterday showed progress
 * 1/2 on the daily 2-trades challenge and never completed it. The wallet
 * ledger records one row per executed trade and is the count the
 * challenges describe.
 *
 * Method: the service clock is offset so "today" is 2026-12-03, a date
 * whose active rotation includes daily_two_trades, daily_pred_and_perp,
 * weekly_pred_only and weekly_ten_trades. All trades are executed by the
 * real PredictionMarketService / PerpMarketService wired to the real
 * WalletService, firing checkProgress per trade exactly as the routes
 * do; the records those trades produced are then placed on the
 * simulated timeline (first buy on 12-02, the rest on 12-03), and
 * progress is re-checked once per event type — the same check the
 * routes fire on the user's next trade — so the engine observes the
 * timeline the records describe.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  checkProgress,
  getActiveDailyChallengeIds,
  getActiveWeeklyChallengeIds,
  getUserChallenges,
} from '@feed/api';
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

// ── Offset clock: shift "now" to 2026-12-03 (same time of day) ──
const RealDate = Date;
const DAY_MS = 86_400_000;
const SIM_DAY_START = RealDate.UTC(2026, 11, 3); // 2026-12-03T00:00:00Z
const DEC2 = new RealDate('2026-12-02T12:00:00.000Z');
const DEC3 = new RealDate('2026-12-03T12:00:00.000Z');
let dateOffset = 0;

class OffsetDate extends RealDate {
  constructor(...args: [value: string | number | Date] | []) {
    if (args.length === 0) {
      super(RealDate.now() + dateOffset);
    } else {
      super(args[0]);
    }
  }
  static now(): number {
    return RealDate.now() + dateOffset;
  }
}

function installOffsetClock(): void {
  dateOffset = SIM_DAY_START - Math.floor(RealDate.now() / DAY_MS) * DAY_MS;
  (globalThis as { Date: unknown }).Date = OffsetDate;
}

function restoreClock(): void {
  (globalThis as { Date: unknown }).Date = RealDate;
}

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

describe('challenge trade-count progress', () => {
  let userId: string;
  let marketId: string;
  let ticker: string;

  beforeAll(async () => {
    installOffsetClock();

    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      privyId: `did:privy:f91-${userId}`,
      username: `f91-${userId.slice(-10)}`,
      displayName: 'f91',
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

    marketId = await generateSnowflakeId();
    await db.insert(markets).values({
      id: marketId,
      question: `f91-market-${userId}`,
      liquidity: '10000',
      yesShares: '5000',
      noShares: '5000',
      resolved: false,
      endDate: new RealDate('2027-01-01T00:00:00.000Z'),
      updatedAt: new Date(),
    });

    const prediction = makePredictionService();

    // "Yesterday" (12-02): the first buy opens the position.
    await prediction.buy({ userId, marketId, side: 'yes', amount: 10 });
    await checkProgress(userId, { type: 'prediction_trade', marketId });
    // Place yesterday's records on 12-02.
    await db
      .update(positions)
      .set({ createdAt: DEC2 })
      .where(eq(positions.userId, userId));
    await db
      .update(balanceTransactions)
      .set({ createdAt: DEC2 })
      .where(eq(balanceTransactions.userId, userId));

    // "Today" (12-03): four more buys on the same market/side — four
    // trades that merge into the position row opened yesterday.
    for (let i = 0; i < 4; i++) {
      await prediction.buy({ userId, marketId, side: 'yes', amount: 10 });
      await checkProgress(userId, { type: 'prediction_trade', marketId });
    }

    // "Today": perp open + add on one ticker — two trades, one row.
    ticker = `F91${userId.slice(-6).toUpperCase()}`;
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
      userId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 10,
    });
    await checkProgress(userId, { type: 'perp_trade', ticker });
    await perps.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    }); // add — merges into the same position row
    await checkProgress(userId, { type: 'perp_trade', ticker });

    // Place today's records on 12-03: every ledger row that is not
    // yesterday's, and the perp position's openedAt (opened "today").
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    for (const row of ledger) {
      if (row.createdAt.getTime() !== DEC2.getTime()) {
        await db
          .update(balanceTransactions)
          .set({ createdAt: DEC3 })
          .where(eq(balanceTransactions.id, row.id));
      }
    }
    await db
      .update(perpPositions)
      .set({ openedAt: DEC3 })
      .where(eq(perpPositions.userId, userId));

    // Re-check progress once per event type, as the routes do on the
    // user's next trade, so completions are observed on this timeline.
    await checkProgress(userId, { type: 'prediction_trade', marketId });
    await checkProgress(userId, { type: 'perp_trade', ticker });
  });

  afterAll(async () => {
    restoreClock();
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db
      .delete(userAchievements)
      .where(eq(userAchievements.userId, userId));
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
    await db.delete(markets).where(eq(markets.id, marketId));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await db.delete(organizationState).where(eq(organizationState.id, ticker));
  });

  it('premise: the ledger records every trade while position rows merge', async () => {
    // The simulated date's rotation carries the four trade challenges.
    expect(getActiveDailyChallengeIds()).toContain('daily_two_trades');
    expect(getActiveDailyChallengeIds()).toContain('daily_pred_and_perp');
    expect(getActiveWeeklyChallengeIds()).toContain('weekly_pred_only');
    expect(getActiveWeeklyChallengeIds()).toContain('weekly_ten_trades');

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const byTypeDay = new Map<string, number>();
    for (const r of ledger) {
      const key = `${r.type}@${r.createdAt.toISOString().slice(0, 10)}`;
      byTypeDay.set(key, (byTypeDay.get(key) ?? 0) + 1);
    }
    expect(byTypeDay.get('pred_buy@2026-12-02')).toBe(1);
    expect(byTypeDay.get('pred_buy@2026-12-03')).toBe(4);
    expect(byTypeDay.get('perp_open@2026-12-03')).toBe(1);
    expect(byTypeDay.get('perp_add_to_position@2026-12-03')).toBe(1);

    const predRows = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, userId));
    expect(predRows).toHaveLength(1);
    expect(predRows[0]!.createdAt.toISOString()).toBe(DEC2.toISOString());
    const perpRows = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    expect(perpRows).toHaveLength(1);
    expect(perpRows[0]!.openedAt.toISOString()).toBe(DEC3.toISOString());
  });

  it('shows the real trade counts on the challenges list', async () => {
    const view = await getUserChallenges(userId);
    const all = [...view.daily.challenges, ...view.weekly.challenges];
    const byId = new Map(all.map((c) => [c.id, c]));

    // 6 trades today (4 prediction + 2 perp): daily 2-trades completes.
    const twoTrades = byId.get('daily_two_trades');
    expect(twoTrades).toBeDefined();
    expect(twoTrades!.progress).toBe(2);
    expect(twoTrades!.completed).toBe(true);

    // Both types traded today, even though the prediction position was
    // opened yesterday: the both-sides challenge completes.
    const bothSides = byId.get('daily_pred_and_perp');
    expect(bothSides).toBeDefined();
    expect(bothSides!.progress).toBe(1);
    expect(bothSides!.completed).toBe(true);

    // 5 prediction trades this week: the 5-prediction challenge completes.
    const predOnly = byId.get('weekly_pred_only');
    expect(predOnly).toBeDefined();
    expect(predOnly!.progress).toBe(5);
    expect(predOnly!.completed).toBe(true);

    // 7 trades this week: progress is the real count, below threshold.
    const tenTrades = byId.get('weekly_ten_trades');
    expect(tenTrades).toBeDefined();
    expect(tenTrades!.progress).toBe(7);
    expect(tenTrades!.completed).toBe(false);
  });

  it('persists completions and rewards for the traded counts', async () => {
    const rows = await db
      .select()
      .from(userChallengeProgress)
      .where(eq(userChallengeProgress.userId, userId));
    const byIdPeriod = new Map(
      rows.map((r) => [`${r.challengeId}@${r.periodKey}`, r])
    );

    const twoTrades = byIdPeriod.get('daily_two_trades@2026-12-03');
    expect(twoTrades).toBeDefined();
    expect(twoTrades!.completed).toBe(1);
    expect(twoTrades!.pointsAwarded).toBe(55);

    const bothSides = byIdPeriod.get('daily_pred_and_perp@2026-12-03');
    expect(bothSides).toBeDefined();
    expect(bothSides!.completed).toBe(1);
    expect(bothSides!.pointsAwarded).toBe(65);

    const predOnly = byIdPeriod.get('weekly_pred_only@2026-W49');
    expect(predOnly).toBeDefined();
    expect(predOnly!.completed).toBe(1);
    expect(predOnly!.pointsAwarded).toBe(100);

    const tenTrades = byIdPeriod.get('weekly_ten_trades@2026-W49');
    expect(tenTrades).toBeDefined();
    expect(tenTrades!.completed).toBe(0);
    expect(tenTrades!.progress).toBe(7);
  });
});

/**
 * Distinct-markets challenge progress must count the markets a user
 * actually traded inside the window, not the position rows born inside
 * the window.
 *
 * The daily "Market Sampler" challenge ("Trade in 3 different markets")
 * and the weekly "Market Explorer" challenge ("Trade in 5 different
 * markets") read the daily_distinct_markets / weekly_distinct_markets
 * resolvers in achievement-service. Those resolvers counted
 * COUNT(DISTINCT positions.marketId) over position rows whose
 * createdAt falls in the window. A position row is born at the FIRST
 * trade on a market and later trades upsert into it, so a market first
 * traded last week never counts this week no matter how often it is
 * traded now, and a market opened yesterday does not count today. The
 * wallet ledger records one row per executed trade, and prediction
 * trade rows carry the market in relatedId — the distinct markets
 * traded in a window are the distinct relatedIds of its pred_buy /
 * pred_sell rows (settlement pred_resolve and refund pred_cancel rows
 * are not trades).
 *
 * Method: the service clock is offset so "today" is 2027-01-02, a date
 * whose active rotation includes daily_three_markets and
 * weekly_five_markets. All trades are executed by the real
 * PredictionMarketService wired to the real WalletService; the records
 * those trades produced are then placed on the simulated timeline
 * (2026-12-25 last week, 2027-01-01 yesterday, 2027-01-02 today), and
 * progress is checked once — the same check the routes fire on the
 * user's next trade — so the engine observes the timeline the records
 * describe. (Checks are not interleaved with the trades: a check fired
 * before placement would observe records still stamped with the
 * simulated "now".)
 *
 * Timeline: last week buy A, B. Yesterday buy C, D, E and A again.
 * Today buy A, C, D again and sell part of B. Distinct markets traded:
 * today {A,B,C,D} = 4, this week {A,B,C,D,E} = 5. Position rows born:
 * last week {A,B}, yesterday {C,D,E}, today {}.
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
  pointsTransactions,
  positions,
  userAchievements,
  userChallengeProgress,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { WalletService } from '@feed/engine/services/wallet-service';
import { generateSnowflakeId } from '@feed/shared';

// ── Offset clock: shift "now" to 2027-01-02 (same time of day) ──
const RealDate = Date;
const DAY_MS = 86_400_000;
const SIM_DAY_START = RealDate.UTC(2027, 0, 2); // 2027-01-02T00:00:00Z
const LASTWEEK = new RealDate('2026-12-25T12:00:00.000Z');
const YDAY = new RealDate('2027-01-01T12:00:00.000Z');
const TODAY = new RealDate('2027-01-02T12:00:00.000Z');
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

describe('challenge distinct-markets progress', () => {
  let userId: string;
  const marketIds: Record<string, string> = {};

  async function placeLedger(exceptTimes: number[], at: RealDate) {
    const rows = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    for (const row of rows) {
      if (!exceptTimes.includes(row.createdAt.getTime())) {
        await db
          .update(balanceTransactions)
          .set({ createdAt: at })
          .where(eq(balanceTransactions.id, row.id));
      }
    }
  }

  async function placePositions(exceptTimes: number[], at: RealDate) {
    const rows = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, userId));
    for (const row of rows) {
      if (!exceptTimes.includes(row.createdAt.getTime())) {
        await db
          .update(positions)
          .set({ createdAt: at })
          .where(eq(positions.id, row.id));
      }
    }
  }

  beforeAll(async () => {
    installOffsetClock();

    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      privyId: `did:privy:f92-${userId}`,
      username: `f92-${userId.slice(-10)}`,
      displayName: 'f92',
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

    for (const label of ['A', 'B', 'C', 'D', 'E']) {
      const id = await generateSnowflakeId();
      marketIds[label] = id;
      await db.insert(markets).values({
        id,
        question: `f92-market-${label}-${userId}`,
        liquidity: '10000',
        yesShares: '5000',
        noShares: '5000',
        resolved: false,
        endDate: new RealDate('2027-06-01T00:00:00.000Z'),
        updatedAt: new Date(),
      });
    }

    const prediction = makePredictionService();
    const buy = (label: string) =>
      prediction.buy({
        userId,
        marketId: marketIds[label]!,
        side: 'yes',
        amount: 10,
      });

    // Last week (2026-12-25): buy A and B — rows born last week.
    await buy('A');
    await buy('B');
    await placeLedger([], LASTWEEK);
    await placePositions([], LASTWEEK);

    // Yesterday (2027-01-01, same ISO week): buy C, D, E (rows born)
    // and A again (upsert into last week's row).
    await buy('C');
    await buy('D');
    await buy('E');
    await buy('A');
    await placeLedger([LASTWEEK.getTime()], YDAY);
    await placePositions([LASTWEEK.getTime()], YDAY);

    // Today (2027-01-02): buy A, C, D again (upserts) and sell part of
    // B (a trade today on a market whose row was born last week).
    await buy('A');
    await buy('C');
    await buy('D');
    await prediction.sell({ userId, marketId: marketIds.B!, shares: 2 });
    await placeLedger([LASTWEEK.getTime(), YDAY.getTime()], TODAY);

    // Re-check progress once, as the routes do on the user's next
    // trade, so completions are observed on this timeline.
    await checkProgress(userId, {
      type: 'prediction_trade',
      marketId: marketIds.A!,
    });
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
    await db.delete(users).where(eq(users.id, userId));
    for (const label of Object.keys(marketIds)) {
      await db.delete(markets).where(eq(markets.id, marketIds[label]!));
    }
  });

  it('premise: the ledger records the traded markets while position rows stay at their birth dates', async () => {
    // The simulated date's rotation carries both distinct-markets challenges.
    expect(getActiveDailyChallengeIds()).toContain('daily_three_markets');
    expect(getActiveWeeklyChallengeIds()).toContain('weekly_five_markets');

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const byTypeDay = new Map<string, number>();
    for (const r of ledger) {
      const key = `${r.type}@${r.createdAt.toISOString().slice(0, 10)}`;
      byTypeDay.set(key, (byTypeDay.get(key) ?? 0) + 1);
    }
    expect(byTypeDay.get('pred_buy@2026-12-25')).toBe(2);
    expect(byTypeDay.get('pred_buy@2027-01-01')).toBe(4);
    expect(byTypeDay.get('pred_buy@2027-01-02')).toBe(3);
    expect(byTypeDay.get('pred_sell@2027-01-02')).toBe(1);

    // Distinct markets actually traded, from the ledger itself.
    const labelOf = new Map(
      Object.entries(marketIds).map(([label, id]) => [id, label])
    );
    const distinctLabels = (from: string, to: string) => {
      const s = new Set<string>();
      for (const r of ledger) {
        if (
          (r.type === 'pred_buy' || r.type === 'pred_sell') &&
          r.createdAt >= new RealDate(from) &&
          r.createdAt < new RealDate(to) &&
          r.relatedId
        ) {
          s.add(labelOf.get(r.relatedId) ?? r.relatedId);
        }
      }
      return [...s].sort();
    };
    expect(distinctLabels('2027-01-02', '2027-01-03')).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(distinctLabels('2026-12-28', '2027-01-04')).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);

    // Position rows: five, born last week (A, B) and yesterday (C, D,
    // E) — none born today, although four markets were traded today.
    const posRows = await db
      .select()
      .from(positions)
      .where(eq(positions.userId, userId));
    expect(posRows).toHaveLength(5);
    const bornDays = posRows
      .map((r) => r.createdAt.toISOString().slice(0, 10))
      .sort();
    expect(bornDays).toEqual([
      '2026-12-25',
      '2026-12-25',
      '2027-01-01',
      '2027-01-01',
      '2027-01-01',
    ]);
  });

  it('shows the real distinct-market counts on the challenges list', async () => {
    const view = await getUserChallenges(userId);
    const all = [...view.daily.challenges, ...view.weekly.challenges];
    const byId = new Map(all.map((c) => [c.id, c]));

    // 4 distinct markets traded today: the 3-market daily completes.
    const sampler = byId.get('daily_three_markets');
    expect(sampler).toBeDefined();
    expect(sampler!.progress).toBe(3);
    expect(sampler!.completed).toBe(true);

    // 5 distinct markets traded this week: the 5-market weekly completes.
    const explorer = byId.get('weekly_five_markets');
    expect(explorer).toBeDefined();
    expect(explorer!.progress).toBe(5);
    expect(explorer!.completed).toBe(true);
  });

  it('persists completions and rewards for the traded markets', async () => {
    const rows = await db
      .select()
      .from(userChallengeProgress)
      .where(eq(userChallengeProgress.userId, userId));
    const byIdPeriod = new Map(
      rows.map((r) => [`${r.challengeId}@${r.periodKey}`, r])
    );

    const sampler = byIdPeriod.get('daily_three_markets@2027-01-02');
    expect(sampler).toBeDefined();
    expect(sampler!.completed).toBe(1);
    expect(sampler!.progress).toBe(4);
    expect(sampler!.pointsAwarded).toBe(35);

    const explorer = byIdPeriod.get('weekly_five_markets@2026-W53');
    expect(explorer).toBeDefined();
    expect(explorer!.completed).toBe(1);
    expect(explorer!.progress).toBe(5);
    expect(explorer!.pointsAwarded).toBe(150);
  });
});

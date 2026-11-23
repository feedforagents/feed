/**
 * Real service + real DB repro: the buy-side hard
 * floor/ceiling (2%/98%) has no "worsens" carve-out, unlike the sell
 * guard added by #2073. A buy that unwinds an already-extreme market
 * toward 50% is rejected whenever it still lands outside 2-98%.
 *
 * Reachability on base staging (sells are unguarded there): user A buys
 * NO while YES is low (guard-compliant), user B buys YES up to 97.5%
 * (guard-compliant), then A sells NO legs and YES walks past 98%.
 * A fresh user C then cannot buy the cheap NO side to unwind it.
 *
 * Each step drives the real PredictionMarketService through the real
 * PredictionDbAdapter against the real test Postgres (same wiring as
 * the production buy route). The wallet port is the no-op stub used by
 * the existing market integration suites.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  PredictionDbAdapter,
  PredictionMarketService,
  PredictionPricing,
} from '@feed/core/markets/prediction';
import {
  count,
  db,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { generateSnowflakeId } from '@feed/shared';

const testUserIds: string[] = [];
const testMarketIds: string[] = [];

async function createTestUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    privyId: `did:privy:test-${id}`,
    username: `buy-unwind-${id}`,
    displayName: 'buy-unwind',
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
    question: `buy-unwind-${id}`,
    liquidity: (params.yesShares + params.noShares).toFixed(2),
    yesShares: params.yesShares.toFixed(6),
    noShares: params.noShares.toFixed(6),
    resolved: false,
    endDate: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date(),
  });
  testMarketIds.push(id);
  return id;
}

function marketService(): PredictionMarketService {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 100000 }),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });
}

async function readPool(marketId: string): Promise<{
  yesShares: number;
  noShares: number;
}> {
  const [row] = await db.select().from(markets).where(eq(markets.id, marketId));
  assert.ok(row, 'market row missing');
  return {
    yesShares: Number(row.yesShares),
    noShares: Number(row.noShares),
  };
}

function yesPrice(pool: { yesShares: number; noShares: number }): number {
  return pool.noShares / (pool.yesShares + pool.noShares);
}

/**
 * Largest whole-cent buy amount whose guard outcome stays inside the
 * given move cap and landing band. Mirrors the service's own guard
 * arithmetic (same pricing, same fee rate) so the search only ever
 * returns amounts the service accepts.
 */
function maxGuardedAmount(
  pool: { yesShares: number; noShares: number },
  side: 'yes' | 'no',
  maxMove: number,
  floor: number,
  ceiling: number
): number {
  const cur = yesPrice(pool);
  let lo = 0;
  let hi = 200_000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const calc = PredictionPricing.calculateBuyWithFees(
      pool.yesShares,
      pool.noShares,
      side,
      mid,
      FEE_CONFIG.TRADING_FEE_RATE
    );
    const ok =
      Math.abs(calc.newYesPrice - cur) <= maxMove &&
      calc.newYesPrice >= floor &&
      calc.newYesPrice <= ceiling;
    if (ok) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo * 100) / 100;
}

afterAll(async () => {
  if (testMarketIds.length > 0) {
    await db
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, testMarketIds));
    await db
      .delete(positions)
      .where(inArray(positions.marketId, testMarketIds));
    await db.delete(markets).where(inArray(markets.id, testMarketIds));
  }
  if (testUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, testUserIds));
  }
  if (testMarketIds.length > 0) {
    const [historyLeft] = await db
      .select({ n: count() })
      .from(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, testMarketIds));
    assert.equal(historyLeft?.n, 0, 'price-history rows left behind');
    const [positionsLeft] = await db
      .select({ n: count() })
      .from(positions)
      .where(inArray(positions.marketId, testMarketIds));
    assert.equal(positionsLeft?.n, 0, 'position rows left behind');
    const [marketsLeft] = await db
      .select({ n: count() })
      .from(markets)
      .where(inArray(markets.id, testMarketIds));
    assert.equal(marketsLeft?.n, 0, 'market rows left behind');
  }
  if (testUserIds.length > 0) {
    const [usersLeft] = await db
      .select({ n: count() })
      .from(users)
      .where(inArray(users.id, testUserIds));
    assert.equal(usersLeft?.n, 0, 'user rows left behind');
  }
});

describe('Prediction — buy unwinding an extreme market (real DB)', () => {
  test('extreme market reached by ordinary service calls, then NO buy unwinds it', async () => {
    const service = marketService();
    const userA = await createTestUser();
    const userB = await createTestUser();
    const userC = await createTestUser();
    const marketId = await createMarket({ yesShares: 5000, noShares: 5000 });

    // 1. A accumulates NO while YES is low (guard-compliant buys).
    for (let i = 0; i < 10; i++) {
      const pool = await readPool(marketId);
      if (yesPrice(pool) <= 0.15) break;
      const amount = maxGuardedAmount(pool, 'no', 0.19, 0.025, 0.975);
      assert.ok(amount >= 1, 'no guarded NO amount found');
      await service.buy({ userId: userA, marketId, side: 'no', amount });
    }
    const [posA] = await db
      .select()
      .from(positions)
      .where(eq(positions.marketId, marketId));
    console.log(
      'after A accumulation:',
      JSON.stringify(await readPool(marketId)),
      'A NO shares:',
      posA ? Number(posA.shares).toFixed(0) : 'none'
    );

    // 2. B walks YES up to ~97.5% with guard-compliant YES buys.
    for (let i = 0; i < 30; i++) {
      const pool = await readPool(marketId);
      if (yesPrice(pool) >= 0.97) break;
      const amount = maxGuardedAmount(pool, 'yes', 0.19, 0.025, 0.98);
      assert.ok(amount >= 1, 'no guarded YES amount found');
      await service.buy({ userId: userB, marketId, side: 'yes', amount });
    }
    console.log(
      'after B walk-up:',
      JSON.stringify(await readPool(marketId)),
      'YES:',
      (yesPrice(await readPool(marketId)) * 100).toFixed(2) + '%'
    );

    // 3. A sells NO legs (unguarded on base) — YES must cross 98%.
    const before = yesPrice(await readPool(marketId));
    await service.sell({ userId: userA, marketId, shares: 2000 });
    const extreme = await readPool(marketId);
    console.log(
      'after A sell 2000 NO: YES',
      (yesPrice(extreme) * 100).toFixed(2) + '%',
      JSON.stringify(extreme)
    );
    expect(yesPrice(extreme)).toBeGreaterThan(0.98);
    expect(yesPrice(extreme)).toBeGreaterThan(before);

    // 4. C buys the cheap NO side: the trade unwinds toward 50% but
    // still lands above 98% — the buy guard rejects it on base.
    const result = await service
      .buy({ userId: userC, marketId, side: 'no', amount: 10 })
      .then(
        (r) => ({ ok: true as const, yesPrice: r.market.yesPrice }),
        (e: Error) => ({ ok: false as const, message: e.message })
      );
    console.log('C unwind buy result:', JSON.stringify(result));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const after = await readPool(marketId);
      expect(yesPrice(after)).toBeLessThan(yesPrice(extreme));
      expect(yesPrice(after)).toBeGreaterThan(0.5);
    }
  });

  test('control: worsening buy past 98% is still rejected', async () => {
    const service = marketService();
    const user = await createTestUser();
    const marketId = await createMarket({ yesShares: 250, noShares: 9750 });
    await expect(
      service.buy({
        userId: user,
        marketId,
        side: 'yes',
        amount: 2000,
        maxOddsMove: 1.0,
      })
    ).rejects.toThrow(/thin|push YES odds/i);
  });

  test('control: ordinary small buy on a balanced market succeeds', async () => {
    const service = marketService();
    const user = await createTestUser();
    const marketId = await createMarket({ yesShares: 5000, noShares: 5000 });
    await expect(
      service.buy({ userId: user, marketId, side: 'yes', amount: 50 })
    ).resolves.toBeDefined();
  });
});

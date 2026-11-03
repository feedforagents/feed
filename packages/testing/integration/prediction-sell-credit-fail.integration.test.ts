/**
 * Real Postgres: prediction sell credit failure.
 *
 * 1. A credit that is known not to have landed restores pool and shares by
 *    inverse delta, so a trade that committed during the credit stays.
 * 2. A credit that committed and then threw (lost response) is not reversed.
 * 3. Repeating WalletService.credit with the same attempt id pays once.
 *    relatedId stays the market id.
 *
 * Run with:
 *   DATABASE_URL=postgresql://feed:feed_dev_password@127.0.0.1:5433/feed \
 *     bun test packages/testing/integration/prediction-sell-credit-fail.integration.test.ts \
 *     --preload packages/testing/integration/preload.ts
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
  PredictionPricing,
} from '@feed/core/markets/prediction';
import type { WalletPort } from '@feed/core/markets/shared';
import {
  balanceTransactions,
  db,
  eq,
  markets,
  positions,
  predictionPriceHistories,
  sql,
  users,
} from '@feed/db';
import { createUserWalletAdapter, WalletService } from '@feed/engine';
import { generateSnowflakeId, WalletCreditNotAppliedError } from '@feed/shared';

const FEE_RATE = 0.001;
const userIds: string[] = [];
const marketIds: string[] = [];

async function createFixture() {
  const userId = await generateSnowflakeId();
  const marketId = await generateSnowflakeId();
  const now = new Date();
  userIds.push(userId);
  marketIds.push(marketId);

  await db.insert(users).values({
    id: userId,
    privyId: `did:privy:test-sell-credit-${userId}`,
    username: `sell-credit-${userId.slice(-8)}`,
    displayName: `sell-credit-${userId.slice(-8)}`,
    virtualBalance: '1000.00',
    totalDeposited: '0',
    totalWithdrawn: '0',
    reputationPoints: 1000,
    profileComplete: true,
    updatedAt: now,
  });
  await db.insert(markets).values({
    id: marketId,
    question: 'Integration: sell credit failure',
    yesShares: '6000',
    noShares: '4000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    updatedAt: now,
  });
  const position = await new PredictionDbAdapter().upsertPosition({
    userId,
    marketId,
    side: 'yes',
    shares: 100,
    avgPrice: 0.5,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return { userId, marketId, positionId: position.id };
}

function serviceFor(wallet: WalletPort): PredictionMarketService {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet,
    cache: { invalidate: async () => {} },
    clock: { now: () => new Date() },
    fees: {
      tradingFeeRate: FEE_RATE,
      platformShare: 0.5,
      referrerShare: 0.5,
      minFeeAmount: 0.01,
    },
  });
}

afterAll(async () => {
  for (const marketId of marketIds) {
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, marketId));
    await db.delete(positions).where(eq(positions.marketId, marketId));
    await db.delete(markets).where(eq(markets.id, marketId));
  }
  for (const userId of userIds) {
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe('prediction sell credit failure (real Postgres)', () => {
  it('restores by inverse delta and keeps a concurrent trade', async () => {
    const { userId, marketId, positionId } = await createFixture();
    const beforeRows = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId));
    const beforeYes = Number(beforeRows[0]?.yesShares);
    const beforeNo = Number(beforeRows[0]?.noShares);
    const beforeLiquidity = Number(beforeRows[0]?.liquidity);

    const base = createUserWalletAdapter();
    const wallet: WalletPort = {
      debit: (args) => base.debit(args),
      credit: async () => {
        await db
          .update(markets)
          .set({
            yesShares: sql`${markets.yesShares} + 100`,
            liquidity: sql`${markets.liquidity} + 25`,
            updatedAt: new Date(),
          })
          .where(eq(markets.id, marketId));
        await db
          .update(positions)
          .set({
            shares: sql`${positions.shares} - 15`,
            updatedAt: new Date(),
          })
          .where(eq(positions.id, positionId));
        throw new WalletCreditNotAppliedError('wallet credit failed');
      },
      creditWasApplied: (args) =>
        WalletService.creditWasApplied(args.userId, args.idempotencyKey),
      recordPnL: async () => {},
      getBalance: (id) => base.getBalance(id),
    };

    await expect(
      serviceFor(wallet).sell({
        marketId,
        userId,
        shares: 40,
        positionId,
      })
    ).rejects.toThrow('wallet credit failed');

    const afterRows = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId));
    expect(Number(afterRows[0]?.yesShares)).toBeCloseTo(beforeYes + 100, 4);
    expect(Number(afterRows[0]?.noShares)).toBeCloseTo(beforeNo, 4);
    expect(Number(afterRows[0]?.liquidity)).toBeCloseTo(
      beforeLiquidity + 25,
      4
    );

    const [pos] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, positionId));
    expect(Number(pos?.shares)).toBeCloseTo(85, 4);
    expect(pos?.status).toBe('active');
    expect((await WalletService.getBalance(userId)).balance).toBeCloseTo(
      1000,
      4
    );
  });

  it('keeps shares sold when the credit committed and the response was lost', async () => {
    const { userId, marketId, positionId } = await createFixture();
    const marketRow = await db
      .select()
      .from(markets)
      .where(eq(markets.id, marketId));
    const quote = PredictionPricing.calculateSellWithFees(
      Number(marketRow[0]?.yesShares),
      Number(marketRow[0]?.noShares),
      'yes',
      40,
      FEE_RATE
    );
    const net = quote.netProceeds ?? 0;

    const base = createUserWalletAdapter();
    let calls = 0;
    const wallet: WalletPort = {
      debit: (args) => base.debit(args),
      credit: async (args) => {
        calls += 1;
        await base.credit(args);
        throw new Error('credit response lost');
      },
      creditWasApplied: (args) =>
        WalletService.creditWasApplied(args.userId, args.idempotencyKey),
      recordPnL: async () => {},
      getBalance: (id) => base.getBalance(id),
    };

    const sold = await serviceFor(wallet).sell({
      marketId,
      userId,
      shares: 40,
      positionId,
    });
    expect(calls).toBe(1);
    expect(sold.netProceeds).toBeCloseTo(net, 4);

    const [pos] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, positionId));
    expect(Number(pos?.shares)).toBeCloseTo(60, 4);
    expect(pos?.status).toBe('active');

    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const credits = ledger.filter((row) => row.type === 'pred_sell');
    expect(credits).toHaveLength(1);
    expect(credits[0]?.relatedId).toBe(marketId);
    expect(Number(credits[0]?.amount)).toBeCloseTo(net, 2);
    expect((await WalletService.getBalance(userId)).balance).toBeCloseTo(
      1000 + net,
      2
    );
  });

  it('pays a repeated credit with the same attempt id once', async () => {
    const { userId, marketId } = await createFixture();
    const key = await generateSnowflakeId();
    await WalletService.credit(
      userId,
      12.5,
      'pred_sell',
      'Sell YES',
      marketId,
      undefined,
      key
    );
    await WalletService.credit(
      userId,
      12.5,
      'pred_sell',
      'Sell YES',
      marketId,
      undefined,
      key
    );

    expect((await WalletService.getBalance(userId)).balance).toBeCloseTo(
      1012.5,
      2
    );
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.id, key));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.userId).toBe(userId);
    expect(ledger[0]?.relatedId).toBe(marketId);
    expect(await WalletService.creditWasApplied(userId, key)).toBe(true);

    await expect(
      WalletService.credit(
        'missing-user',
        1,
        'pred_sell',
        'missing',
        marketId,
        undefined,
        await generateSnowflakeId()
      )
    ).rejects.toBeInstanceOf(WalletCreditNotAppliedError);
  });
});

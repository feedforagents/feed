/** PRD §§9.1–9.2 / MVP phase 6: a redeemable share lot must survive a sale. */
import { afterAll, beforeAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runIsolatedPredictionRemainderCases,
  startPredictionRemainderServer,
  verifyPredictionRemainderChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_PREDICTION_REMAINDER_CHILD) {
  test('runs all ten prediction remainder HTTP cases in a leased fresh database', async () => {
    await runIsolatedPredictionRemainderCases();
  }, 300_000);
} else {
  // Verify positive database ownership before importing any application clients.
  await verifyPredictionRemainderChildLease();
  const {
    balanceTransactions,
    db,
    eq,
    markets,
    positions,
    sql,
    tradingFees,
    users,
  } = await import('@feed/db');
  const { FEE_CONFIG, withPredictionSettlement } = await import('@feed/engine');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { z } = await import('zod');
  const { getAdminToken } = await import('./helpers');
  const receipts: Array<{ table: string; id: string; canonical: string }> = [];
  let api:
    | Awaited<ReturnType<typeof startPredictionRemainderServer>>
    | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    api = await startPredictionRemainderServer();
    baseUrl = api.url;
  }, 40_000);

  afterAll(async () => {
    try {
      await api?.stop();
    } finally {
      try {
        await db.$disconnect();
      } finally {
        writeFileSync(
          join(
            dirname(process.env.FEED_PREDICTION_REMAINDER_LEASE_FILE!),
            'fixture-receipts.json'
          ),
          JSON.stringify(receipts, null, 2) + '\n',
          { mode: 0o600 }
        );
      }
    }
  }, 20_000);

  // The positively leased child owns the complete dataset, including genuine
  // asynchronous achievement/challenge effects. No rows or progress states are
  // forged, adopted or deleted here. The API/test process group must exit before
  // the parent can drop the child; any failure retains its database and logs.
  const options = {
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  };
  const saleSchema = z.object({
    remainingShares: z.number(),
    positionClosed: z.boolean(),
    netProceeds: z.number(),
    pnl: z.number(),
    fee: z.object({ amount: z.number() }),
  });
  const cents = (value: number | string) => Math.round(Number(value) * 100);

  for (const side of ['yes', 'no'] as const) {
    for (const scenario of [
      'cent',
      'above',
      'dust',
      'whole',
      'loser',
    ] as const) {
      test(`${side} ${scenario} funded remainder sells and settles through real HTTP`, async () => {
        const userId = await generateSnowflakeId();
        const marketId = await generateSnowflakeId();
        const now = new Date();
        const userRows = await db
          .insert(users)
          .values({
            id: userId,
            username: `share-remainder-${userId}`,
            virtualBalance: '2000',
            totalDeposited: '2000',
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: users.id,
            canonical: sql<string>`to_jsonb(${users})::text`,
          });
        receipts.push(...userRows.map((row) => ({ table: 'User', ...row })));
        assert.equal(
          userRows.length,
          1,
          'Successful full physical User RETURNING required'
        );
        const marketRows = await db
          .insert(markets)
          .values({
            id: marketId,
            question: `Synthetic share remainder ${marketId}`,
            yesShares: '5000',
            noShares: '5000',
            liquidity: '10000',
            endDate: new Date(Date.now() + 86_400_000),
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: markets.id,
            canonical: sql<string>`to_jsonb(${markets})::text`,
          });
        receipts.push(
          ...marketRows.map((row) => ({ table: 'Market', ...row }))
        );
        assert.equal(
          marketRows.length,
          1,
          'Successful full physical Market RETURNING required'
        );
        const bought = await withPredictionSettlement(
          marketId,
          { userId },
          (service) => service.buy({ userId, marketId, side, amount: 1000 }),
          options
        );
        const [beforeSaleUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const [held] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, bought.positionId));
        assert.ok(beforeSaleUser && held);
        const remainder =
          scenario === 'whole'
            ? 0
            : scenario === 'dust'
              ? 0.009999
              : scenario === 'above'
                ? 0.010001
                : 0.01;
        const toSell =
          (Math.round(Number(held.shares) * 1_000_000) -
            Math.round(remainder * 1_000_000)) /
          1_000_000;
        if (remainder === 0.01)
          assert.ok(
            Number(held.shares) - toSell < 0.01,
            'The funded fixture must exercise binary subtraction below the boundary'
          );
        const response = await fetch(
          `${baseUrl}/api/markets/predictions/${marketId}/sell`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              authorization: `Bearer steward:test:${userId}`,
            },
            body: JSON.stringify({ shares: toSell, positionId: held.id }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          }
        );
        assert.equal(response.status, 200);
        const sale = saleSchema.parse(await response.json());
        const closed = remainder < 0.01;
        assert.equal(sale.positionClosed, closed);
        assert.ok(
          Math.abs(sale.remainingShares - (closed ? 0 : remainder)) < 1e-9
        );
        const [afterSale] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, held.id));
        assert.ok(afterSale);
        assert.equal(Number(afterSale.shares), closed ? 0 : remainder);
        assert.equal(afterSale.status, closed ? 'closed' : 'active');
        const [beforeUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        assert.ok(beforeUser);
        assert.equal(
          cents(beforeUser.virtualBalance) -
            cents(beforeSaleUser.virtualBalance),
          cents(sale.netProceeds)
        );
        const saleCredits = (
          await db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, userId))
        ).filter((row) => row.type === 'pred_sell');
        assert.equal(saleCredits.length, 1);
        assert.equal(
          cents(saleCredits[0]?.amount ?? NaN),
          cents(sale.netProceeds)
        );
        const fees = await db
          .select()
          .from(tradingFees)
          .where(eq(tradingFees.userId, userId));
        assert.equal(fees.length, 1);
        assert.equal(fees[0]?.tradeType, 'pred_sell');
        assert.equal(fees[0]?.tradeId, held.id);
        assert.equal(fees[0]?.marketId, marketId);
        assert.equal(cents(fees[0]?.feeAmount ?? NaN), cents(sale.fee.amount));
        assert.equal(
          cents(beforeUser.totalFeesPaid) - cents(beforeSaleUser.totalFeesPaid),
          cents(sale.fee.amount)
        );
        assert.notEqual(held.cashCostBasis, null);
        assert.equal(
          cents(held.cashCostBasis ?? NaN),
          cents(afterSale.cashCostBasis ?? NaN) +
            cents(sale.netProceeds) -
            cents(sale.pnl)
        );
        assert.equal(
          cents(Number(afterSale.pnl ?? 0) - Number(held.pnl ?? 0)),
          cents(sale.pnl)
        );
        assert.equal(
          cents(
            Number(beforeUser.lifetimePnL) - Number(beforeSaleUser.lifetimePnL)
          ),
          cents(sale.pnl)
        );
        const token = getAdminToken();
        assert.ok(token, 'Integration admin token is required');
        const resolve = () =>
          fetch(`${baseUrl}/api/admin/markets/${marketId}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-dev-admin-token': token,
            },
            body: JSON.stringify({
              action: 'resolve',
              resolution:
                scenario === 'loser' ? side !== 'yes' : side === 'yes',
              reason: `Synthetic share remainder ${marketId}`,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          });
        assert.equal((await resolve()).status, 200);
        const [afterUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const [settled] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, held.id));
        assert.ok(afterUser && settled);
        const expected = closed || scenario === 'loser' ? 0 : 0.01;
        assert.equal(
          (cents(afterUser.virtualBalance) - cents(beforeUser.virtualBalance)) /
            100,
          expected
        );
        const credits = (
          await db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, userId))
        ).filter((row) => row.type === 'pred_resolve');
        assert.equal(credits.length, expected > 0 ? 1 : 0);
        if (expected > 0) assert.equal(Number(credits[0]?.amount), expected);
        assert.equal(settled.status, 'resolved');
        assert.equal(Number(settled.cashCostBasis), 0);
        assert.equal(
          cents(Number(afterUser.lifetimePnL) - Number(beforeUser.lifetimePnL)),
          cents(expected - Number(afterSale.cashCostBasis))
        );
        assert.equal(
          cents(Number(settled.pnl ?? 0) - Number(afterSale.pnl ?? 0)),
          cents(expected - Number(afterSale.cashCostBasis))
        );
        assert.equal((await resolve()).status, 400);
        const [repeatUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const [repeatPosition] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, held.id));
        assert.ok(repeatUser);
        assert.equal(repeatUser.virtualBalance, afterUser.virtualBalance);
        assert.equal(repeatUser.lifetimePnL, afterUser.lifetimePnL);
        assert.deepEqual(repeatPosition, settled);
        assert.deepEqual(
          (
            await db
              .select()
              .from(balanceTransactions)
              .where(eq(balanceTransactions.userId, userId))
          ).filter((row) => row.type === 'pred_resolve'),
          credits
        );
      });
    }
  }
}

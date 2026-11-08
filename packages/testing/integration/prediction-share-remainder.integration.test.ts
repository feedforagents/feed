/** PRD §§9.1–9.2 / MVP phase 6: a redeemable share lot must survive a sale. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  adminAuditLogs,
  balanceTransactions,
  db,
  eq,
  markets,
  notifications,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { FEE_CONFIG, withPredictionSettlement } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { getAdminToken } from './helpers';

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
});
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

for (const side of ['yes', 'no'] as const) {
  for (const scenario of ['cent', 'above', 'dust', 'whole', 'loser'] as const) {
    test(`${side} ${scenario} funded remainder sells and settles through real HTTP`, async () => {
      const userId = await generateSnowflakeId();
      const marketId = await generateSnowflakeId();
      try {
        await db.insert(users).values({
          id: userId,
          username: `share-remainder-${userId}`,
          virtualBalance: '2000',
          totalDeposited: '2000',
          updatedAt: new Date(),
        });
        await db.insert(markets).values({
          id: marketId,
          question: `Synthetic share remainder ${marketId}`,
          yesShares: '5000',
          noShares: '5000',
          liquidity: '10000',
          endDate: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        });
        const bought = await withPredictionSettlement(
          marketId,
          { userId },
          (service) => service.buy({ userId, marketId, side, amount: 1000 }),
          options
        );
        const [held] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, bought.positionId));
        assert.ok(held);
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
              reason: 'Synthetic share remainder regression',
            }),
          });
        assert.equal((await resolve()).status, 200);
        assert.equal((await resolve()).status, 400);
        const [afterUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        assert.ok(afterUser);
        const expected = closed || scenario === 'loser' ? 0 : 0.01;
        assert.equal(
          (Math.round(Number(afterUser.virtualBalance) * 100) -
            Math.round(Number(beforeUser.virtualBalance) * 100)) /
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
        const [settled] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, held.id));
        assert.ok(settled);
        assert.equal(settled.status, 'resolved');
        assert.equal(Number(settled.cashCostBasis), 0);
      } finally {
        for (const table of [
          notifications,
          pointsTransactions,
          balanceTransactions,
          tradingFees,
          tradingFeeOutbox,
          positions,
        ]) {
          await db.delete(table).where(eq(table.userId, userId));
        }
        await db
          .delete(predictionPriceHistories)
          .where(eq(predictionPriceHistories.marketId, marketId));
        await db
          .delete(adminAuditLogs)
          .where(eq(adminAuditLogs.resourceId, marketId));
        await db.delete(markets).where(eq(markets.id, marketId));
        await db.delete(users).where(eq(users.id, userId));
      }
    });
  }
}

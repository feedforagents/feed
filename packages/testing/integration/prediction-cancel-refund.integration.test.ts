/** PRD §9.1 / MVP phase 6: cancellation returns held gross cash exactly once. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  adminAuditLogs,
  balanceTransactions,
  db,
  eq,
  markets,
  pointsTransactions,
  positions,
  predictionPriceHistories,
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
const responseSchema = z.object({
  success: z.literal(true),
  positionsRefunded: z.number(),
  totalRefunded: z.number(),
});
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

async function cancel(marketId: string) {
  const token = getAdminToken();
  assert.ok(token, 'A configured integration admin token is required');
  const response = await fetch(`${baseUrl}/api/admin/markets/${marketId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dev-admin-token': token },
    body: JSON.stringify({
      action: 'void',
      reason: 'Synthetic refund regression',
    }),
  });
  assert.equal(response.status, 200);
  return responseSchema.parse(await response.json());
}

for (const side of ['yes', 'no'] as const) {
  for (const scenario of ['whole', 'partial', 'legacy'] as const) {
    test(`${side} ${scenario} cancellation refunds held cash through actual HTTP exactly once`, async () => {
      const userId = await generateSnowflakeId();
      const marketId = await generateSnowflakeId();
      try {
        await db.insert(users).values({
          id: userId,
          username: `cancel-refund-${userId}`,
          virtualBalance: '2000',
          totalDeposited: '2000',
          updatedAt: new Date(),
        });
        await db.insert(markets).values({
          id: marketId,
          question: 'Synthetic cancellation refund regression',
          yesShares: '5000',
          noShares: '5000',
          liquidity: '10000',
          endDate: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        });
        const buy = await withPredictionSettlement(
          marketId,
          { userId },
          (service) => service.buy({ userId, marketId, side, amount: 1000 }),
          options
        );
        if (scenario === 'partial') {
          await withPredictionSettlement(
            marketId,
            { userId },
            (service) =>
              service.sell({
                userId,
                marketId,
                shares: Math.floor(buy.shares / 2),
              }),
            options
          );
        }
        const [beforePosition] = await db
          .select()
          .from(positions)
          .where(eq(positions.marketId, marketId));
        const [beforeUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        assert.ok(beforePosition);
        assert.ok(beforeUser);
        const expectedRefund = scenario === 'partial' ? 500.45 : 1000;
        assert.equal(Number(beforePosition.cashCostBasis), expectedRefund);
        if (scenario === 'legacy') {
          // A genuinely funded holding, converted only to the old nullable shape.
          await db
            .update(positions)
            .set({ cashCostBasis: null })
            .where(eq(positions.id, beforePosition.id));
        }
        const result = await cancel(marketId);
        assert.equal(result.positionsRefunded, 1);
        assert.equal(result.totalRefunded, expectedRefund);
        const repeated = await cancel(marketId);
        assert.equal(repeated.positionsRefunded, 0);
        assert.equal(repeated.totalRefunded, 0);
        const [afterUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const [afterPosition] = await db
          .select()
          .from(positions)
          .where(eq(positions.id, beforePosition.id));
        assert.ok(afterUser);
        assert.ok(afterPosition);
        assert.equal(
          Number(afterUser.virtualBalance),
          Number(beforeUser.virtualBalance) + expectedRefund
        );
        assert.equal(afterUser.lifetimePnL, beforeUser.lifetimePnL);
        assert.equal(Number(afterPosition.pnl), Number(beforePosition.pnl));
        assert.equal(afterPosition.status, 'cancelled');
        assert.equal(Number(afterPosition.cashCostBasis), 0);
        const credits = (
          await db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, userId))
        ).filter((row) => row.type === 'pred_cancel');
        assert.equal(credits.length, 1);
        assert.equal(Number(credits[0]?.amount), expectedRefund);
      } finally {
        for (const table of [
          pointsTransactions,
          balanceTransactions,
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

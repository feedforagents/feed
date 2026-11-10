/** PRD §§9.1–9.2 / MVP Phase 6: historical values match real settled credits. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
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
import { floorPoints, generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';

const responseSchema = z.object({
  predictions: z.object({
    positions: z.array(
      z.object({
        marketId: z.string(),
        currentValue: z.number(),
        costBasis: z.number(),
        unrealizedPnL: z.number(),
        status: z.string(),
      })
    ),
  }),
});
const options = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};

for (const side of ['yes', 'no'] as const) {
  for (const wins of [true, false]) {
    test(`${side} ${wins ? 'winner' : 'loser'} history agrees with persisted settlement`, async () => {
      const userId = await generateSnowflakeId();
      const marketId = await generateSnowflakeId();
      try {
        await db.insert(users).values({
          id: userId,
          username: `resolved-snapshot-${userId}`,
          virtualBalance: '1000',
          totalDeposited: '1000',
          updatedAt: new Date(),
        });
        await db.insert(markets).values({
          id: marketId,
          question: 'Synthetic resolved snapshot regression',
          yesShares: '5000',
          noShares: '5000',
          liquidity: '10000',
          endDate: new Date(Date.now() + 86_400_000),
          updatedAt: new Date(),
        });
        const buy = await withPredictionSettlement(
          marketId,
          { userId },
          (service) => service.buy({ userId, marketId, side, amount: 10 }),
          options
        );
        assert.notEqual(buy.shares, floorPoints(buy.shares));
        const winningSide = wins ? side : side === 'yes' ? 'no' : 'yes';
        const resolve = () =>
          withPredictionSettlement(
            marketId,
            { system: 'resolved_snapshot_test' },
            (service) => service.resolve({ marketId, winningSide }),
            options
          );
        await resolve();
        await resolve(); // A second resolution must not credit again.
        const ledger = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, userId));
        const credits = ledger.filter((row) => row.type === 'pred_resolve');
        const expectedCredit = wins ? floorPoints(buy.shares) : 0;
        assert.equal(credits.length, wins ? 1 : 0);
        assert.equal(Number(credits[0]?.amount ?? 0), expectedCredit);
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        assert.ok(user);
        assert.equal(Number(user.virtualBalance), 990 + expectedCredit);

        const baseUrl =
          process.env.TEST_API_URL ||
          process.env.TEST_BASE_URL ||
          'http://127.0.0.1:3100';
        const response = await fetch(
          new URL(
            `/api/markets/positions/${userId}?type=prediction&status=closed`,
            baseUrl
          ),
          { headers: { authorization: `Bearer steward:test:${userId}` } }
        );
        assert.equal(response.status, 200);
        const body = responseSchema.parse(await response.json());
        const snapshot = body.predictions.positions.find(
          (row) => row.marketId === marketId
        );
        assert.ok(snapshot);
        assert.equal(snapshot.status, 'resolved');
        assert.equal(snapshot.currentValue, expectedCredit);
        // Cost basis remains an estimate; do not equate this to ledger P&L.
        assert.equal(
          snapshot.unrealizedPnL,
          expectedCredit - snapshot.costBasis
        );
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
        await db.delete(markets).where(eq(markets.id, marketId));
        await db.delete(users).where(eq(users.id, userId));
      }
    });
  }
}

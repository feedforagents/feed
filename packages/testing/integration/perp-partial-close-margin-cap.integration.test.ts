/** PRD §9.1 / MVP Phase 6: partial-close accounting must match settled losses. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  users,
} from '@feed/db';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';

for (const side of ['long', 'short'] as const) {
  test(`caps cumulative ${side} PnL after partial and final gap closes`, async () => {
    const uid = 'dot-cap-' + crypto.randomUUID(),
      ticker = 'DOTCAP' + crypto.randomUUID().slice(0, 8).toUpperCase();
    try {
      await db.insert(users).values({
        id: uid,
        username: uid,
        virtualBalance: '10000',
        totalDeposited: '10000',
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
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
      const service = createPerpMarketService();
      const opened = await service.openPosition({
        userId: uid,
        ticker,
        side,
        size: 100,
        leverage: 10,
      });
      await db
        .update(perpMarketSnapshots)
        .set({ currentPrice: side === 'long' ? 50 : 200 })
        .where(eq(perpMarketSnapshots.ticker, ticker));
      const half = await service.closePosition({
        userId: uid,
        positionId: opened.positionId,
        percentage: 0.5,
      });
      const [partial] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, opened.positionId));
      const last = await service.closePosition({
        userId: uid,
        positionId: opened.positionId,
      });
      const [closed] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, opened.positionId));
      const [user] = await db.select().from(users).where(eq(users.id, uid));
      assert.ok(user && partial && closed);
      assert.equal(half.realizedPnL, -5);
      assert.equal(last.realizedPnL, -5);
      assert.equal(Number(user.virtualBalance), 9989.9);
      assert.equal(Number(user.lifetimePnL), -10.1);
      assert.equal(partial.realizedPnL, -5);
      assert.equal(closed.realizedPnL, -10);
    } finally {
      await db
        .delete(pointsTransactions)
        .where(eq(pointsTransactions.userId, uid));
      await db
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, uid));
      await db.delete(perpPositions).where(eq(perpPositions.userId, uid));
      await db
        .delete(stockPrices)
        .where(eq(stockPrices.organizationId, ticker));
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
      await db.delete(users).where(eq(users.id, uid));
    }
  });
}

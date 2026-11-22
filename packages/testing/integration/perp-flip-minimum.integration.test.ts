/** PRD §9.3 / MVP Phase 6: reject dust flips before preview or settlement. */
import { expect, test } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';

for (const side of ['long', 'short'] as const) {
  test(`rejects dust ${side} flip without mutation and permits exact minimum`, async () => {
    const userId = `dot-min-${crypto.randomUUID()}`;
    const ticker = `DOTMIN${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
    const opposite = side === 'long' ? 'short' : 'long';
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    const request = (path: string, size: number) =>
      new Request(
        `${process.env.TEST_API_URL ?? 'http://localhost:3000'}/api/markets/perps/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer steward:test:${userId}`,
          },
          body: JSON.stringify({ ticker, side: opposite, size, leverage: 10 }),
        }
      );
    const snapshot = async () => ({
      user: await db.select().from(users).where(eq(users.id, userId)),
      positions: await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.userId, userId)),
      ledger: await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId)),
      fees: await db
        .select()
        .from(tradingFees)
        .where(eq(tradingFees.userId, userId)),
    });
    try {
      await db.insert(users).values({
        id: userId,
        username: userId,
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
      const service = createPerpMarketService({ withPriceImpact: true });
      await service.openPosition({
        userId,
        ticker,
        side,
        size: 100,
        leverage: 10,
      });
      const before = await snapshot();
      for (const size of [101, 109.99]) {
        const quoted = await fetch(request('preview', size));
        expect(quoted.status).toBe(400);
        expect((await quoted.json()).error).toBe(
          'Order size below minimum (10)'
        );
        const executed = await fetch(request('open', size));
        expect(executed.status).toBe(400);
        expect((await executed.json()).error).toBe(
          'Order size below minimum (10)'
        );
        expect(await snapshot()).toEqual(before);
      }
      const quoted = await fetch(request('preview', 110));
      expect(quoted.status).toBe(200);
      expect((await quoted.json()).preview.resultingSize).toBe(10);
      const executed = await service.openPosition({
        userId,
        ticker,
        side: opposite,
        size: 110,
        leverage: 10,
      });
      const [position] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, executed.positionId));
      expect(position?.side).toBe(opposite);
      expect(position?.size).toBe(10);
    } finally {
      await db
        .delete(tradingFeeOutbox)
        .where(eq(tradingFeeOutbox.userId, userId));
      await db.delete(tradingFees).where(eq(tradingFees.userId, userId));
      await db
        .delete(pointsTransactions)
        .where(eq(pointsTransactions.userId, userId));
      await db
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
      await db
        .delete(stockPrices)
        .where(eq(stockPrices.organizationId, ticker));
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
      await db.delete(users).where(eq(users.id, userId));
      if (previousTestAuth === undefined)
        delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  });
}

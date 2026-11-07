/** PRD §9.3 / MVP Phase 6: the real preview route must quote the execution fill. */
import { expect, test } from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  stockPrices,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';
import { POST } from '../../../apps/web/src/app/api/markets/perps/preview/route';

const cases = [
  { side: 'long', opposite: 'short', size: 3000 },
  { side: 'short', opposite: 'long', size: 3000 },
  { side: 'long', opposite: 'short', size: 500 },
  { side: 'long', opposite: 'short', size: 1000 },
] as const;

for (const { side, opposite, size } of cases) {
  test(`real preview matches ${side} to ${opposite} rebalance of ${size}`, async () => {
    const userId = `preview-${crypto.randomUUID()}`;
    const ticker = `PREVIEW${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
    const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
    try {
      await db.insert(users).values({
        id: userId,
        username: userId,
        virtualBalance: '1011',
        totalDeposited: '1011',
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
      const opened = await service.openPosition({
        userId,
        ticker,
        side,
        size: 1000,
        leverage: 2,
      });
      const [before] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(Number(before?.virtualBalance)).toBe(510);
      const request = new NextRequest(
        'http://localhost/api/markets/perps/preview',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer steward:test:${userId}`,
          },
          body: JSON.stringify({ ticker, side: opposite, size, leverage: 2 }),
        }
      );
      const response = await POST(request);
      expect(response.status).toBe(200);
      const { preview } = await response.json();
      const [afterPreview] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));
      expect(afterPreview?.virtualBalance).toBe(before?.virtualBalance);
      const executed = await service.openPosition({
        userId,
        ticker,
        side: opposite,
        size,
        leverage: 2,
      });
      const [after] = await db.select().from(users).where(eq(users.id, userId));
      const [original] = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, opened.positionId));
      const debit =
        Number(before?.virtualBalance) - Number(after?.virtualBalance);
      expect(preview.totalRequired).toBeCloseTo(Math.max(0, debit), 6);
      expect(preview.estimatedClosePrice).toBeCloseTo(
        executed.exitPrice ?? Number(original?.currentPrice),
        6
      );
      if (size === 3000) {
        expect(debit).toBeCloseTo(503, 6);
        expect(Number(after?.virtualBalance)).toBe(7);
        expect(preview.totalRequired).toBeLessThanOrEqual(510);
      }
    } finally {
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

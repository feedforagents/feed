/** PRD §9.3 / MVP phase 6: real route previews agree with settled AMM fills. */
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
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';
import { POST } from '../../../apps/web/src/app/api/markets/perps/preview/route';

for (const side of ['long', 'short'] as const) {
  for (const kind of ['open', 'add', 'reduce', 'close', 'flip'] as const) {
    test(`${side} ${kind}: real preview agrees with persisted execution and does not mutate the wallet`, async () => {
      const userId = await generateSnowflakeId();
      const ticker = `AMMPREVIEW${userId}`;
      const oldAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
      process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
      try {
        await db.insert(users).values({
          id: userId,
          username: `amm-preview-${userId}`,
          virtualBalance: '100000',
          totalDeposited: '100000',
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
        const previous =
          kind === 'open'
            ? null
            : await service.openPosition({
                userId,
                ticker,
                side,
                size: 1000,
                leverage: 10,
              });
        const opposite = side === 'long' ? 'short' : 'long';
        const orderSide = kind === 'open' || kind === 'add' ? side : opposite;
        const size = kind === 'reduce' ? 500 : kind === 'close' ? 1000 : 5000;
        const [before] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const rowsBefore = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.userId, userId));
        const previewRequest = (auth: boolean) =>
          new NextRequest('http://localhost/api/markets/perps/preview', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(auth
                ? { authorization: `Bearer steward:test:${userId}` }
                : {}),
            },
            body: JSON.stringify({
              ticker,
              side: orderSide,
              size,
              leverage: 10,
            }),
          });
        const response = await POST(previewRequest(true));
        expect(response.status).toBe(200);
        const { preview } = await response.json();
        expect(preview.previewType).toBe(kind);
        if (kind === 'open') {
          const anonymous = await POST(previewRequest(false));
          expect(anonymous.status).toBe(200);
          expect((await anonymous.json()).preview.executionPrice).toBe(
            preview.executionPrice
          );
        }
        const [afterPreview] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(afterPreview?.virtualBalance).toBe(before?.virtualBalance);
        expect(
          await db
            .select()
            .from(perpPositions)
            .where(eq(perpPositions.userId, userId))
        ).toEqual(rowsBefore);
        const executed = await service.openPosition({
          userId,
          ticker,
          side: orderSide,
          size,
          leverage: 10,
        });
        const [after] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const debit =
          Number(before?.virtualBalance) - Number(after?.virtualBalance);
        expect(preview.totalRequired).toBeCloseTo(Math.max(0, debit), 6);
        if (kind === 'open' || kind === 'add' || kind === 'flip') {
          const fill =
            kind === 'add' && previous
              ? (executed.entryPrice * 6000 - previous.entryPrice * 1000) / 5000
              : executed.entryPrice;
          expect(preview.executionPrice).toBeCloseTo(fill, 6);
          expect(preview.liquidationPrice).toBeCloseTo(
            executed.liquidationPrice,
            6
          );
        }
        if (previous && kind !== 'add') {
          const [closed] = await db
            .select()
            .from(perpPositions)
            .where(eq(perpPositions.id, previous.positionId));
          expect(preview.estimatedClosePrice).toBeCloseTo(
            executed.exitPrice ?? Number(closed?.currentPrice),
            6
          );
          if (kind === 'reduce' || kind === 'close')
            expect(preview.estimatedCloseSettlement).toBeCloseTo(-debit, 6);
          else
            expect(preview.estimatedCloseSettlement).toBeCloseTo(
              400 + 4 - debit,
              6
            );
        }
      } finally {
        await Bun.sleep(100);
        for (const table of [
          pointsTransactions,
          balanceTransactions,
          tradingFees,
          tradingFeeOutbox,
          perpPositions,
        ])
          await db.delete(table).where(eq(table.userId, userId));
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
        if (oldAuth === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
        else process.env.ALLOW_TEST_PRIVY_DID_AUTH = oldAuth;
      }
    });
  }
}

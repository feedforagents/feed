/** Existing A2A accounting correctness, PRD §§9.3–9.4; not new A2A scope. */
import { expect, test } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

class OwnedMarketDb extends PerpDbAdapter {
  constructor(private readonly ticker: string) {
    super();
  }
  async listMarkets() {
    return (await super.listMarkets()).filter((m) => m.ticker === this.ticker);
  }
  async listOpenPositions() {
    return (await super.listOpenPositions()).filter(
      (p) => p.ticker === this.ticker
    );
  }
}
const responseSchema = z.object({
  marketPositions: z.array(z.object({ id: z.string() })),
  perpPositions: z.array(
    z.object({ id: z.string(), unrealizedPnL: z.number() })
  ),
  totalPnL: z.number(),
});
for (const dominant of ['long', 'short'] as const) {
  test(`A2A nets ${dominant}-dominant funding through real accrual and partial/full settlement`, async () => {
    const userIds = [await generateSnowflakeId(), await generateSnowflakeId()];
    const ticker = `A2AFUND${userIds[0]}`;
    const adapter = new OwnedMarketDb(ticker);
    const service = new PerpMarketService({
      db: adapter,
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
    const positionIds: string[] = [];
    async function snapshot(userId: string) {
      const result = responseSchema.parse(
        await FeedAgentExecutor.executeDirectly(
          'portfolio.get_positions',
          {},
          userId
        )
      );
      const rows = await adapter.getOpenPositionsByUser(userId);
      expect(result.marketPositions).toHaveLength(0);
      expect(result.perpPositions).toHaveLength(rows.length);
      for (const row of rows)
        expect(
          result.perpPositions.find((p) => p.id === row.id)?.unrealizedPnL
        ).toBeCloseTo(row.unrealizedPnL - row.fundingPaid, 8);
      expect(result.totalPnL).toBeCloseTo(
        rows.reduce((sum, p) => sum + p.unrealizedPnL - p.fundingPaid, 0),
        8
      );
      return result;
    }
    try {
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
        markPrice: 100,
        indexPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 0,
        volume24h: 0,
        bidDepth: 1000000,
        askDepth: 1000000,
        fundingRate: {
          ticker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: new Date().toISOString(),
        },
      });
      for (let i = 0; i < 2; i++) {
        const id = userIds[i]!;
        const side = i === 0 ? 'long' : 'short';
        await db.insert(users).values({
          id,
          username: `a2a-fund-${id}`,
          virtualBalance: '100000',
          totalDeposited: '100000',
          updatedAt: new Date(),
        });
        const opened = await service.openPosition({
          userId: id,
          ticker,
          side,
          size: side === dominant ? 8000 : 4000,
          leverage: 10,
        });
        positionIds.push(opened.positionId);
        await snapshot(id);
      }
      const walletsBefore = await db
        .select({ id: users.id, balance: users.virtualBalance })
        .from(users)
        .where(inArray(users.id, userIds))
        .orderBy(users.id);
      await service.processFundingStep();
      expect(
        await db
          .select({ id: users.id, balance: users.virtualBalance })
          .from(users)
          .where(inArray(users.id, userIds))
          .orderBy(users.id)
      ).toEqual(walletsBefore);
      for (let i = 0; i < 2; i++) {
        const id = userIds[i]!,
          positionId = positionIds[i]!;
        const funded = await adapter.getPositionById(positionId);
        expect(funded).not.toBeNull();
        expect(Math.sign(funded!.fundingPaid)).toBe(
          (i === 0 ? 'long' : 'short') === dominant ? 1 : -1
        );
        await snapshot(id);
        await service.closePosition({
          userId: id,
          positionId,
          percentage: 0.5,
        });
        const partial = await adapter.getPositionById(positionId);
        expect(partial!.fundingPaid).toBeCloseTo(funded!.fundingPaid / 2, 10);
        await snapshot(id);
        await service.closePosition({ userId: id, positionId });
        const closed = await snapshot(id);
        expect(closed.perpPositions).toHaveLength(0);
        expect(closed.totalPnL).toBe(0);
        expect(await snapshot(id)).toEqual(closed);
        const ledger = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, id));
        expect(ledger.filter((r) => r.type === 'perp_open')).toHaveLength(1);
        expect(
          ledger.filter((r) => r.type === 'perp_partial_close')
        ).toHaveLength(1);
        expect(ledger.filter((r) => r.type === 'perp_close')).toHaveLength(1);
      }
    } finally {
      for (const table of [
        pointsTransactions,
        balanceTransactions,
        perpPositions,
      ])
        await db.delete(table).where(inArray(table.userId, userIds));
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });
}

/** PRD §§9.3–9.4 / MVP phase 6: portfolio equity includes unsettled funding. */
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
  calculatePortfolioPnL,
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/users/[userId]/portfolio-breakdown/route';
import { TradingPerformanceService } from '../../api/src/services/trading-performance-service';

// Scope the real funding operation to this test's market. Rows, locks, wallet
// debits, funding calculations and close settlement all use real PostgreSQL.
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

for (const dominant of ['long', 'short'] as const) {
  for (const side of ['long', 'short'] as const) {
    test(`${side} portfolio nets ${dominant}-dominant funding once across partial and full close`, async () => {
      const userIds = [
        await generateSnowflakeId(),
        await generateSnowflakeId(),
      ];
      const ticker = `FUNDVALUE${userIds[0]}`;
      const ownerId = userIds[0]!;
      const otherId = userIds[1]!;
      const size = side === dominant ? 8000 : 4000;
      const otherSize = side === dominant ? 4000 : 8000;
      const fees = {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      };
      const adapter = new OwnedMarketDb(ticker);
      const service = new PerpMarketService({
        db: adapter,
        wallet: createUserWalletAdapter(),
        settlement: createPerpSettlement(),
        fees,
      });
      const snapshot = async () => {
        const response = await GET(
          new NextRequest(
            `http://localhost/api/users/${ownerId}/portfolio-breakdown`
          ),
          { params: Promise.resolve({ userId: ownerId }) }
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        const [owner] = await db
          .select()
          .from(users)
          .where(eq(users.id, ownerId));
        const open = await adapter.getOpenPositionsByUser(ownerId);
        const equity = open.reduce(
          (sum, p) =>
            sum +
            Math.abs(p.size / p.leverage) +
            p.unrealizedPnL -
            p.fundingPaid,
          0
        );
        expect(body.wallet).toBe(Number(owner!.virtualBalance));
        expect(body.positions).toBeCloseTo(equity, 8);
        expect(body.totalAssets).toBeCloseTo(body.wallet + equity, 8);
        expect(body.totalPnL).toBeCloseTo(body.totalAssets - 100000, 8);
        const pnl = await calculatePortfolioPnL(ownerId);
        expect(pnl).not.toBeNull();
        expect(pnl!.unrealizedPerpPnL).toBeCloseTo(
          open.reduce((sum, p) => sum + p.unrealizedPnL - p.fundingPaid, 0),
          8
        );
        expect(pnl!.totalPnL).toBeCloseTo(
          Number(owner!.lifetimePnL) + pnl!.unrealizedPerpPnL,
          8
        );
        const leaderboard =
          await TradingPerformanceService.getWalletEntry(ownerId);
        expect(leaderboard).not.toBeNull();
        expect(Number(leaderboard!.netProfit)).toBeCloseTo(pnl!.totalPnL, 8);
        return body;
      };
      try {
        for (const id of userIds)
          await db.insert(users).values({
            id,
            username: `fund-value-${id}`,
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
        const opened = await service.openPosition({
          userId: ownerId,
          ticker,
          side,
          size,
          leverage: 10,
        });
        await service.openPosition({
          userId: otherId,
          ticker,
          side: side === 'long' ? 'short' : 'long',
          size: otherSize,
          leverage: 10,
        });
        const before = await snapshot();
        const ledgerBefore = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, ownerId));
        await service.processFundingStep();
        const funded = await adapter.getPositionById(opened.positionId);
        expect(funded).not.toBeNull();
        expect(Math.sign(funded!.fundingPaid)).toBe(side === dominant ? 1 : -1);
        const after = await snapshot();
        expect(after.wallet).toBe(before.wallet);
        expect(after.totalAssets - before.totalAssets).toBeCloseTo(
          -funded!.fundingPaid,
          8
        );
        expect(
          await db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, ownerId))
        ).toEqual(ledgerBefore);

        const partial = await service.closePosition({
          userId: ownerId,
          positionId: opened.positionId,
          percentage: 0.5,
        });
        const remaining = await adapter.getPositionById(opened.positionId);
        expect(remaining!.closedAt).toBeUndefined();
        expect(remaining!.size).toBe(size / 2);
        expect(remaining!.fundingPaid).toBeCloseTo(funded!.fundingPaid / 2, 10);
        const afterPartial = await snapshot();
        expect(afterPartial.wallet - after.wallet).toBeCloseTo(
          Math.max(
            0,
            partial.marginPaid! + partial.realizedPnL! - partial.feePaid
          ),
          2
        );

        await service.closePosition({
          userId: ownerId,
          positionId: opened.positionId,
        });
        const final = await snapshot();
        expect(final.positions).toBe(0);
        expect(await adapter.getOpenPositionsByUser(ownerId)).toHaveLength(0);
        const closed = await adapter.getPositionById(opened.positionId);
        expect(closed!.closedAt).toBeInstanceOf(Date);
        const ledger = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, ownerId));
        expect(ledger.filter((r) => r.type === 'perp_open')).toHaveLength(1);
        expect(
          ledger.filter((r) => r.type === 'perp_partial_close')
        ).toHaveLength(1);
        expect(ledger.filter((r) => r.type === 'perp_close')).toHaveLength(1);
        expect(
          (await calculatePortfolioPnL(ownerId))!.accountEquity
        ).toBeCloseTo(final.totalAssets, 2);
        expect(await snapshot()).toEqual(final);
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
}

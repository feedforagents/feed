/**
 * PRD §9.3 / MVP Phase 6: a liquidation settles accrued funding with the
 * position, wallet and P&L in one transaction.
 */
import { expect, test } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
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
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const cases = [
  // A long that received 5 pts of funding keeps that rebate as equity.
  { name: 'credits an accrued funding rebate', fundingPaid: -5 },
  // A long that owes funding cannot lose more than its margin.
  { name: 'caps owed funding at the margin', fundingPaid: 5 },
] as const;

for (const { name, fundingPaid } of cases) {
  for (const failFirstCredit of [false, true]) {
    test(`liquidation ${name}${failFirstCredit ? ' after a failed wallet write' : ''}`, async () => {
      const userId = await generateSnowflakeId(),
        ticker = `LIQFUND${userId}`;
      let armed = false;
      let walletWrites = 0;
      try {
        await db.insert(users).values({
          id: userId,
          username: `liq-fund-${userId}`,
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
            predictedRate: 0,
            nextFundingTime: new Date().toISOString(),
          },
        });
        const service = new PerpMarketService({
          db: new PerpDbAdapter(),
          wallet: createUserWalletAdapter(),
          settlement: createPerpSettlement({
            wallet: (_owner, tx, afterCommit) => {
              const real = createUserWalletAdapter(tx, afterCommit);
              // Fault injection at the wallet boundary only: the first
              // liquidation wallet write fails, every later one is real.
              const fail = () => {
                if (!armed) return;
                walletWrites++;
                if (failFirstCredit && walletWrites === 1)
                  throw new Error('Owned wallet outage');
              };
              return {
                ...real,
                credit: async (params) => {
                  fail();
                  return real.credit(params);
                },
                recordPnL: async (params) => {
                  fail();
                  return real.recordPnL(params);
                },
              };
            },
          }),
          fees: {
            tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
            platformShare: FEE_CONFIG.PLATFORM_SHARE,
            referrerShare: FEE_CONFIG.REFERRER_SHARE,
            minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
          },
        });
        const opened = await service.openPosition({
          userId,
          ticker,
          side: 'long',
          size: 100,
          leverage: 10,
        });
        // Opening debits the wallet through the same settlement port; arm
        // the fault only for the liquidation.
        armed = true;
        await db
          .update(perpPositions)
          .set({ fundingPaid })
          .where(eq(perpPositions.id, opened.positionId));
        const [before] = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.id, opened.positionId));
        const [ownerBefore] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(before && ownerBefore).toBeTruthy();

        const trigger = Number((before!.liquidationPrice - 0.1).toFixed(2));
        const margin = before!.size / before!.leverage;
        const pnl =
          ((trigger - before!.entryPrice) / before!.entryPrice) * before!.size;
        const realized = Math.max(pnl - fundingPaid, -margin);
        const equity = Math.max(0, margin + realized);

        const first = await service.applyPriceUpdates({ [ticker]: trigger });
        if (failFirstCredit) {
          // The failed write rolls the whole liquidation back: the position
          // stays open, so the next tick can settle it.
          expect(first.liquidations).toBe(0);
          expect(first.errors.length).toBe(1);
          const [still] = await db
            .select()
            .from(perpPositions)
            .where(eq(perpPositions.id, opened.positionId));
          expect(still!.closedAt).toBeNull();
          const retry = await service.applyPriceUpdates({ [ticker]: trigger });
          expect(retry.liquidations).toBe(1);
        } else {
          expect(first.liquidations).toBe(1);
        }

        const [closed] = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.id, opened.positionId));
        const [owner] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(closed!.closedAt).not.toBeNull();
        expect(closed!.realizedPnL).toBeCloseTo(realized, 6);
        expect(Number(owner!.virtualBalance)).toBeCloseTo(
          Number(ownerBefore!.virtualBalance) + equity,
          2
        );
        expect(Number(owner!.lifetimePnL)).toBeCloseTo(
          Number(ownerBefore!.lifetimePnL) + realized,
          2
        );
        const credits = (
          await db
            .select()
            .from(balanceTransactions)
            .where(eq(balanceTransactions.userId, userId))
        ).filter((row) => row.type === 'perp_liquidation');
        expect(credits).toHaveLength(equity > 0 ? 1 : 0);
      } finally {
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
      }
    });
  }
}

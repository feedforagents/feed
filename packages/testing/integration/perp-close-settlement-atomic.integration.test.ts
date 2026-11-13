/**
 * PRD §9.3 / MVP Phase 6: a user close commits the position, the margin
 * credit and the P&L in one transaction, so a failed wallet write can never
 * leave a closed position whose margin was not paid back.
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

type Wallet = ReturnType<typeof createUserWalletAdapter>;

for (const percentage of [1, 0.5]) {
  for (const failFirstCredit of [false, true]) {
    test(`${percentage === 1 ? 'full' : 'partial'} close settles margin and P&L atomically${failFirstCredit ? ' after a failed wallet write' : ''}`, async () => {
      const userId = await generateSnowflakeId(),
        ticker = `CLOSEATOM${userId}`;
      let armed = false;
      let walletWrites = 0;
      // Fault injection at the wallet boundary only: once armed, the first
      // wallet write of the close fails and every later one is real. Both the
      // service wallet and the settlement wallet are wrapped, so the fault
      // fires wherever the close writes the wallet.
      const withFault = (real: Wallet): Wallet => {
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
      };
      try {
        await db.insert(users).values({
          id: userId,
          username: `close-atom-${userId}`,
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
          wallet: withFault(createUserWalletAdapter()),
          settlement: createPerpSettlement({
            wallet: (_owner, tx, afterCommit) =>
              withFault(createUserWalletAdapter(tx, afterCommit)),
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
        // Opening writes the wallet too; arm the fault only for the close.
        armed = true;
        const [before] = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.id, opened.positionId));
        const [ownerBefore] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(before && ownerBefore).toBeTruthy();
        const closeReason =
          percentage === 1 ? 'perp_close' : 'perp_partial_close';
        const closeCredits = async () =>
          (
            await db
              .select()
              .from(balanceTransactions)
              .where(eq(balanceTransactions.userId, userId))
          ).filter((row) => row.type === closeReason);

        const close = () =>
          service.closePosition({
            userId,
            positionId: opened.positionId,
            percentage,
          });

        if (failFirstCredit) {
          await expect(close()).rejects.toThrow('Owned wallet outage');
          // The failed credit rolls the whole close back: the position keeps
          // its full size, no margin is credited, and the user can retry.
          const [still] = await db
            .select()
            .from(perpPositions)
            .where(eq(perpPositions.id, opened.positionId));
          const [ownerStill] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId));
          expect(still!.closedAt).toBeNull();
          expect(still!.size).toBeCloseTo(before!.size, 6);
          expect(Number(ownerStill!.virtualBalance)).toBeCloseTo(
            Number(ownerBefore!.virtualBalance),
            6
          );
          expect(await closeCredits()).toHaveLength(0);
        }

        await close();

        const [after] = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.id, opened.positionId));
        const [owner] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        const credits = await closeCredits();
        expect(credits).toHaveLength(1);
        const credited = Number(credits[0]!.amount);
        const margin = (before!.size * percentage) / before!.leverage;
        expect(credited).toBeGreaterThan(0);
        if (percentage === 1) {
          expect(after!.closedAt).not.toBeNull();
        } else {
          expect(after!.closedAt).toBeNull();
          expect(after!.size).toBeCloseTo(before!.size / 2, 6);
        }
        // Exactly one settlement reached the wallet: the balance moved by the
        // one credit, and lifetime P&L by that credit less the margin returned.
        expect(Number(owner!.virtualBalance)).toBeCloseTo(
          Number(ownerBefore!.virtualBalance) + credited,
          6
        );
        expect(Number(owner!.lifetimePnL)).toBeCloseTo(
          Number(ownerBefore!.lifetimePnL) + credited - margin,
          6
        );
      } finally {
        // The close fee bookkeeping runs detached; let it land before cleanup.
        await new Promise((resolve) => setTimeout(resolve, 500));
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

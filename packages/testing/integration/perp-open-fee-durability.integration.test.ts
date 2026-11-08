/** PRD §§9.1/9.3: a committed open succeeds with fee work durably accounted for. */
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
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
  FeeService,
} from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { createTradingFeeOutboxAdapter } from '../../../apps/web/src/lib/services/trading-fee-outbox';

for (const side of ['long', 'short'] as const) {
  for (const outage of ['transient', 'persistent'] as const) {
    test(`${side}: ${outage} fee failure has completed or queued fee work before open returns`, async () => {
      const userId = await generateSnowflakeId(),
        ticker = `FEEOPEN${userId}`;
      let attempts = 0;
      try {
        await db.insert(users).values({
          id: userId,
          username: `fee-open-${userId}`,
          virtualBalance: '10000',
          totalDeposited: '10000',
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
          settlement: createPerpSettlement(),
          fees: {
            tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
            platformShare: FEE_CONFIG.PLATFORM_SHARE,
            referrerShare: FEE_CONFIG.REFERRER_SHARE,
            minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
          },
          tradingFeeOutbox: createTradingFeeOutboxAdapter(),
          feeProcessor: {
            processTradingFee: async (params) => {
              attempts++;
              // Fault injection at the fee boundary only. All settlement, fee
              // recovery and durable outbox operations use their real services.
              if (outage === 'persistent' || attempts < 3)
                throw new Error('Owned fee-ledger outage');
              return FeeService.processTradingFee(
                params.userId,
                FEE_CONFIG.FEE_TYPES.PERP_OPEN,
                params.amount,
                params.positionId,
                params.relatedId
              );
            },
          },
        });
        const result = await service.openPosition({
          userId,
          ticker,
          side,
          size: 1000,
          leverage: 10,
        });
        expect(result.positionId).toBeString();
        const [owner] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        expect(Number(owner!.virtualBalance)).toBe(9899);
        const open = await db
          .select()
          .from(perpPositions)
          .where(eq(perpPositions.userId, userId));
        expect(open).toHaveLength(1);
        expect(open[0]!.size).toBe(1000);
        const debits = await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, userId));
        expect(debits.filter((r) => r.type === 'perp_open')).toHaveLength(1);
        const queued = await db
          .select()
          .from(tradingFeeOutbox)
          .where(eq(tradingFeeOutbox.userId, userId));
        const recorded = await db
          .select()
          .from(tradingFees)
          .where(eq(tradingFees.userId, userId));
        expect(queued).toHaveLength(outage === 'persistent' ? 1 : 0);
        expect(recorded).toHaveLength(outage === 'transient' ? 1 : 0);
        expect(attempts).toBe(3);
        if (outage === 'persistent') {
          expect(queued[0]!.tradeId).toBe(result.positionId);
          expect(queued[0]!.tradeType).toBe('perp_open');
          expect(Number(queued[0]!.tradeAmount)).toBe(1000);
        }
      } finally {
        // The unfixed candidate returns while retries still run. Wait for its
        // owned work before removing fixtures, even when the assertion fails.
        await Bun.sleep(600);
        for (const table of [
          tradingFeeOutbox,
          tradingFees,
          pointsTransactions,
          balanceTransactions,
          perpPositions,
        ])
          await db.delete(table).where(eq(table.userId, userId));
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

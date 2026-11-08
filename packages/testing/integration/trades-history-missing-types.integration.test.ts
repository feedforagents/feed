/**
 * GET /api/trades?userId=... against a real database, fed by the real
 * trading services: the balance entries in a user's own trade history must
 * cover every balance-changing trade event the services record.
 *
 * The route documents itself as the trading feed over "Balance transactions
 * (buys, sells, deposits, withdrawals)" and the canonical fee config
 * (FEE_CONFIG.FEE_TYPES) enumerates the trade types the wallet records:
 * pred_buy, pred_sell, perp_open, perp_close, perp_add_to_position and
 * perp_flip_position. Settlement credits a winning prediction with
 * pred_resolve, a cancelled market refunds with pred_cancel, and the perp
 * service records a partial close as perp_partial_close — the pair of
 * perp_close. The route's type filter listed only five types, so a payout,
 * a refund, an add, a partial close and a flip moved the user's balance
 * without ever appearing in their history.
 *
 * Fixtures are produced by the real PredictionMarketService and
 * PerpMarketService wired to the real WalletService, so every ledger row
 * below is one a production flow writes; the test asserts the premise
 * (the rows exist in BalanceTransaction) before asserting the route shows
 * them. The only stub is the `server-only` marker package.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  balanceTransactions,
  db,
  eq,
  inArray,
  markets,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  positions,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { FEE_CONFIG } from '@feed/engine/config/fees';
import { WalletService } from '@feed/engine/services/wallet-service';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';
import { GET } from '../../../apps/web/src/app/api/trades/route';

const TRADE_TYPES = [
  'pred_buy',
  'pred_sell',
  'pred_resolve',
  'pred_cancel',
  'perp_open',
  'perp_close',
  'perp_add_to_position',
  'perp_partial_close',
  'perp_flip_position',
] as const;

type TradesResponse = {
  trades: Array<{
    type: string;
    transactionType?: string;
    amount?: string;
  }>;
  total: number;
};

describe('user trade history covers every recorded trade event', () => {
  let userId: string;
  const marketIds: string[] = [];
  let ticker: string;

  afterAll(async () => {
    if (userId) {
      await db
        .delete(tradingFeeOutbox)
        .where(eq(tradingFeeOutbox.userId, userId));
      await db.delete(tradingFees).where(eq(tradingFees.userId, userId));
      await db
        .delete(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      await db.delete(positions).where(eq(positions.userId, userId));
      await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    if (marketIds.length > 0) {
      await db.delete(markets).where(inArray(markets.id, marketIds));
    }
    if (ticker) {
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
    }
  });

  it('shows settlement, refund, add, partial close and flip entries', async () => {
    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      privyId: `did:privy:f88-${userId}`,
      username: `f88-test-${userId}`,
      displayName: 'f88-test',
      virtualBalance: '100000',
      totalDeposited: '100000',
      totalWithdrawn: '0',
      lifetimePnL: '0',
      reputationPoints: 0,
      isActor: false,
      isAgent: false,
      profileComplete: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const prediction = new PredictionMarketService({
      db: new PredictionDbAdapter(),
      wallet: {
        debit: ({ userId: u, amount, reason, description, relatedId }) =>
          WalletService.debit(u, amount, reason, description ?? '', relatedId),
        credit: ({ userId: u, amount, reason, description, relatedId }) =>
          WalletService.credit(u, amount, reason, description ?? '', relatedId),
        recordPnL: async ({ userId: u, pnl, reason, relatedId }) => {
          await WalletService.recordPnL(u, pnl, reason, relatedId);
        },
        getBalance: (uid: string) => WalletService.getBalance(uid),
      },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });

    async function makeMarket(tag: string): Promise<string> {
      const marketId = await generateSnowflakeId();
      marketIds.push(marketId);
      await db.insert(markets).values({
        id: marketId,
        question: `f88-${tag}-${marketId}`,
        liquidity: '1000',
        yesShares: '500',
        noShares: '500',
        resolved: false,
        endDate: new Date('2027-01-01T00:00:00.000Z'),
        updatedAt: new Date(),
      });
      return marketId;
    }

    // Prediction: buy -> resolve (settlement payout), buy -> cancel
    // (refund), buy -> sell (already-listed control).
    const marketA = await makeMarket('resolve');
    await prediction.buy({
      userId,
      marketId: marketA,
      side: 'yes',
      amount: 100,
    });
    await prediction.resolve({ marketId: marketA, winningSide: 'yes' });

    const marketB = await makeMarket('cancel');
    await prediction.buy({
      userId,
      marketId: marketB,
      side: 'yes',
      amount: 100,
    });
    await prediction.cancel({ marketId: marketB });

    const marketC = await makeMarket('sell');
    const boughtC = await prediction.buy({
      userId,
      marketId: marketC,
      side: 'yes',
      amount: 100,
    });
    await prediction.sell({
      userId,
      marketId: marketC,
      side: 'yes',
      shares: boughtC.shares / 2,
    });

    // Perps: open -> add -> partial close -> flip -> full close.
    ticker = `F88${userId.slice(-6).toUpperCase()}`;
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
    const perps = createPerpMarketService();
    const opened = await perps.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 200,
      leverage: 10,
    });
    await perps.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 10,
    });
    await perps.closePosition({
      userId,
      positionId: opened.positionId,
      percentage: 0.5,
    });
    await perps.openPosition({
      userId,
      ticker,
      side: 'short',
      size: 400,
      leverage: 10,
    });
    const remaining = await db
      .select()
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId));
    for (const p of remaining) {
      if (!p.closedAt) {
        await perps.closePosition({ userId, positionId: p.id });
      }
    }

    // Premise: the real services recorded every trade type in the ledger.
    const ledger = await db
      .select()
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    const ledgerByType = new Map<string, string[]>();
    for (const row of ledger) {
      const list = ledgerByType.get(row.type) ?? [];
      list.push(row.amount);
      ledgerByType.set(row.type, list);
    }
    for (const type of TRADE_TYPES) {
      expect(ledgerByType.has(type)).toBe(true);
    }

    // The user's history must show every one of those entries, with the
    // ledger amounts.
    const response = await GET(
      new NextRequest(`http://localhost/api/trades?userId=${userId}&limit=100`)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: TradesResponse;
    } & TradesResponse;
    const data = body.data ?? body;
    const balanceItems = data.trades.filter((t) => t.type === 'balance');
    const shownByType = new Map<string, string[]>();
    for (const item of balanceItems) {
      const list = shownByType.get(item.transactionType as string) ?? [];
      list.push(item.amount as string);
      shownByType.set(item.transactionType as string, list);
    }
    for (const type of TRADE_TYPES) {
      expect(shownByType.get(type)?.sort()).toEqual(
        ledgerByType.get(type)?.sort()
      );
    }
    expect(balanceItems.length).toBe(ledger.length);
  });
});

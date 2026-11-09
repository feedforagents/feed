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
  predictionPriceHistories,
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

class HistoryFixture {
  private userIds: string[] = [];
  private marketIds: string[] = [];
  private organizationIds: string[] = [];
  private snapshotTickers: string[] = [];

  async createUser(id = ''): Promise<string> {
    const userId = id || (await generateSnowflakeId());
    const [owned] = await db
      .insert(users)
      .values({
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
      })
      .returning({ id: users.id });
    if (!owned) throw new Error('User insert returned no ownership');
    this.userIds.push(owned.id);
    return owned.id;
  }

  async createMarket(tag: string, id = ''): Promise<string> {
    const marketId = id || (await generateSnowflakeId());
    const [owned] = await db
      .insert(markets)
      .values({
        id: marketId,
        question: `f88-${tag}-${marketId}`,
        liquidity: '1000',
        yesShares: '500',
        noShares: '500',
        resolved: false,
        endDate: new Date('2027-01-01T00:00:00.000Z'),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    if (!owned) throw new Error('Market insert returned no ownership');
    this.marketIds.push(owned.id);
    return owned.id;
  }

  async createOrganization(ticker: string): Promise<void> {
    const [owned] = await db
      .insert(organizationState)
      .values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: new Date(),
      })
      .returning({ id: organizationState.id });
    if (!owned) throw new Error('Organization insert returned no ownership');
    this.organizationIds.push(owned.id);
  }

  async createSnapshot(ticker: string): Promise<void> {
    const [owned] = await db
      .insert(perpMarketSnapshots)
      .values({
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
      })
      .returning({ ticker: perpMarketSnapshots.ticker });
    if (!owned) throw new Error('Snapshot insert returned no ownership');
    this.snapshotTickers.push(owned.ticker);
  }

  async cleanup(): Promise<void> {
    for (const userId of this.userIds) {
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
    if (this.marketIds.length > 0) {
      // Recover service children only beneath parents whose INSERT succeeded,
      // including rows created before a later assertion or setup failure.
      const snapshots = await db
        .select({ id: predictionPriceHistories.id })
        .from(predictionPriceHistories)
        .where(inArray(predictionPriceHistories.marketId, this.marketIds));
      if (snapshots.length > 0) {
        await db.delete(predictionPriceHistories).where(
          inArray(
            predictionPriceHistories.id,
            snapshots.map(({ id }) => id)
          )
        );
      }
      expect(
        await db
          .select({ id: predictionPriceHistories.id })
          .from(predictionPriceHistories)
          .where(inArray(predictionPriceHistories.marketId, this.marketIds))
      ).toHaveLength(0);
      await db.delete(markets).where(inArray(markets.id, this.marketIds));
      expect(
        await db
          .select({ id: markets.id })
          .from(markets)
          .where(inArray(markets.id, this.marketIds))
      ).toHaveLength(0);
    }
    if (this.snapshotTickers.length > 0) {
      await db
        .delete(perpMarketSnapshots)
        .where(inArray(perpMarketSnapshots.ticker, this.snapshotTickers));
      expect(
        await db
          .select({ ticker: perpMarketSnapshots.ticker })
          .from(perpMarketSnapshots)
          .where(inArray(perpMarketSnapshots.ticker, this.snapshotTickers))
      ).toHaveLength(0);
    }
    if (this.organizationIds.length > 0) {
      await db
        .delete(organizationState)
        .where(inArray(organizationState.id, this.organizationIds));
      expect(
        await db
          .select({ id: organizationState.id })
          .from(organizationState)
          .where(inArray(organizationState.id, this.organizationIds))
      ).toHaveLength(0);
    }
    if (this.userIds.length > 0) {
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, this.userIds))
      ).toHaveLength(0);
    }
  }
}

describe('user trade history covers every recorded trade event', () => {
  const fixture = new HistoryFixture();
  afterAll(() => fixture.cleanup());

  it('shows settlement, refund, add, partial close and flip entries', async () => {
    const userId = await fixture.createUser();

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

    // Prediction: buy -> resolve (settlement payout), buy -> cancel
    // (refund), buy -> sell (already-listed control).
    const marketA = await fixture.createMarket('resolve');
    await prediction.buy({
      userId,
      marketId: marketA,
      side: 'yes',
      amount: 100,
    });
    await prediction.resolve({ marketId: marketA, winningSide: 'yes' });

    const marketB = await fixture.createMarket('cancel');
    await prediction.buy({
      userId,
      marketId: marketB,
      side: 'yes',
      amount: 100,
    });
    await prediction.cancel({ marketId: marketB });

    const marketC = await fixture.createMarket('sell');
    const boughtC = await prediction.buy({
      userId,
      marketId: marketC,
      side: 'yes',
      amount: 100,
    });
    await prediction.sell({
      userId,
      marketId: marketC,
      positionId: boughtC.positionId,
      shares: boughtC.shares / 2,
    });

    // Perps: open -> add -> partial close -> flip -> full close.
    const ticker = `F88${userId}`;
    await fixture.createOrganization(ticker);
    await fixture.createSnapshot(ticker);
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

  it('does not acquire existing users, ledgers, markets, organizations or snapshots on collision', async () => {
    const existing = new HistoryFixture();
    const attempted = new HistoryFixture();
    try {
      const userId = await existing.createUser();
      const marketId = await existing.createMarket('collision');
      const ticker = `F88${userId}`;
      await existing.createOrganization(ticker);
      await existing.createSnapshot(ticker);
      await WalletService.debit(
        userId,
        1,
        'pred_buy',
        'collision control',
        marketId
      );
      const readExisting = async () => ({
        users: await db.select().from(users).where(eq(users.id, userId)),
        ledger: await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, userId)),
        markets: await db
          .select()
          .from(markets)
          .where(eq(markets.id, marketId)),
        organizations: await db
          .select()
          .from(organizationState)
          .where(eq(organizationState.id, ticker)),
        snapshots: await db
          .select()
          .from(perpMarketSnapshots)
          .where(eq(perpMarketSnapshots.ticker, ticker)),
      });
      const before = await readExisting();
      expect(before.ledger).toHaveLength(1);
      for (const insert of [
        () => attempted.createUser(userId),
        () => attempted.createMarket('collision', marketId),
        () => attempted.createOrganization(ticker),
        () => attempted.createSnapshot(ticker),
      ]) {
        await expect(insert()).rejects.toMatchObject({
          cause: { code: '23505' },
        });
      }
      await attempted.cleanup();
      expect(await readExisting()).toEqual(before);
    } finally {
      await attempted.cleanup();
      await existing.cleanup();
    }
  });

  it('cleans partial setup without deleting an unacquired snapshot or market', async () => {
    const existing = new HistoryFixture();
    const attempted = new HistoryFixture();
    try {
      const marketId = await existing.createMarket('partial-control');
      const ticker = `F88${await generateSnowflakeId()}`;
      // An existing snapshot does not imply this fixture owns the organization.
      await existing.createSnapshot(ticker);
      const before = await db
        .select()
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      const userId = await attempted.createUser();
      const ownedMarket = await attempted.createMarket('partial');
      await WalletService.debit(
        userId,
        1,
        'pred_buy',
        'partial setup',
        ownedMarket
      );
      await attempted.createOrganization(ticker);
      await expect(attempted.createSnapshot(ticker)).rejects.toMatchObject({
        cause: { code: '23505' },
      });
      await expect(
        attempted.createMarket('collision', marketId)
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await attempted.cleanup();
      expect(
        await db
          .select()
          .from(perpMarketSnapshots)
          .where(eq(perpMarketSnapshots.ticker, ticker))
      ).toEqual(before);
      expect(
        await db.select().from(markets).where(eq(markets.id, marketId))
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(balanceTransactions)
          .where(eq(balanceTransactions.userId, userId))
      ).toHaveLength(0);
    } finally {
      await attempted.cleanup();
      await existing.cleanup();
    }
  });
});

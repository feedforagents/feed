/** PRD §§9.1–9.3 / MVP Phase 6: existing balance-changing trades appear in history. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedTradeHistoryCase,
  startTradeHistoryServer,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the trade history HTTP case in a leased fresh database', async () => {
    await runIsolatedTradeHistoryCase();
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // This Next.js build guard has no database or runtime behavior.
  mock.module('server-only', () => ({}));
  const { PredictionDbAdapter, PredictionMarketService } = await import(
    '@feed/core/markets/prediction'
  );
  const {
    balanceTransactions,
    db,
    eq,
    markets,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    users,
  } = await import('@feed/db');
  const { FEE_CONFIG } = await import('@feed/engine/config/fees');
  const { WalletService } = await import(
    '@feed/engine/services/wallet-service'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { createPerpMarketService } = await import(
    '../../../apps/web/src/app/api/markets/perps/_adapters'
  );

  const tradeTypes = [
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
      id: string;
      market?: { id: string } | null;
      transactionType?: string;
      amount?: string;
    }>;
    total: number;
    hasMore: boolean;
  };

  let api: Awaited<ReturnType<typeof startTradeHistoryServer>>;
  beforeAll(async () => {
    api = await startTradeHistoryServer();
  }, 40_000);
  afterAll(async () => {
    try {
      await api?.stop();
    } finally {
      await db.$disconnect();
    }
  }, 20_000);

  // Only the lease holder retires the database. This fixture never deletes rows
  // by parent ID or assumes ownership of service-created writes.
  async function createUser(): Promise<string> {
    const userId = await generateSnowflakeId();
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
    return owned.id;
  }

  async function createMarket(tag: string): Promise<string> {
    const marketId = await generateSnowflakeId();
    const [owned] = await db
      .insert(markets)
      .values({
        id: marketId,
        question: `f88-${tag}-${marketId}`,
        liquidity: '1000',
        yesShares: '500',
        noShares: '500',
        resolved: false,
        endDate: new Date(Date.now() + 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    if (!owned) throw new Error('Market insert returned no ownership');
    return owned.id;
  }

  async function createOrganization(ticker: string): Promise<void> {
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
  }

  async function createSnapshot(ticker: string): Promise<void> {
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
  }

  async function readTrades(params: Record<string, string>) {
    const url = new URL('/api/trades', api.url);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: TradesResponse;
    } & TradesResponse;
    return body.data ?? body;
  }

  const keys = (data: TradesResponse) =>
    data.trades.map((trade) => `${trade.type}:${trade.id}`);

  async function expectPageWalk(
    params: Record<string, string>,
    data: TradesResponse
  ) {
    const expected = keys(data);
    const walked: string[] = [];
    for (let offset = 0; offset <= data.total; offset += 3) {
      const page = await readTrades({
        ...params,
        limit: '3',
        offset: String(offset),
      });
      expect(page.total).toBe(data.total);
      expect(page.hasMore).toBe(offset + 3 < data.total);
      expect(keys(page)).toEqual(expected.slice(offset, offset + 3));
      walked.push(...keys(page));
    }
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(data.total);
  }

  test('serves the persisted prediction and perp trade history over HTTP', async () => {
    const userId = await createUser();
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
    const marketA = await createMarket('resolve');
    await prediction.buy({
      userId,
      marketId: marketA,
      side: 'yes',
      amount: 100,
    });
    await prediction.resolve({ marketId: marketA, winningSide: 'yes' });

    const marketB = await createMarket('cancel');
    await prediction.buy({
      userId,
      marketId: marketB,
      side: 'yes',
      amount: 100,
    });
    await prediction.cancel({ marketId: marketB });

    const marketC = await createMarket('sell');
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
    await createOrganization(ticker);
    await createSnapshot(ticker);
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
    const persistedTradeTypes = new Set(ledger.map((row) => row.type));
    expect(persistedTradeTypes).toEqual(new Set(tradeTypes));

    const anotherUserId = await createUser();
    await prediction.buy({
      userId: anotherUserId,
      marketId: marketC,
      side: 'yes',
      amount: 50,
    });
    const [unrelatedBalanceRow] = await db
      .select({ id: balanceTransactions.id })
      .from(balanceTransactions)
      .where(eq(balanceTransactions.userId, anotherUserId));
    if (!unrelatedBalanceRow)
      throw new Error('Second trader buy had no ledger row');

    const filtered = await readTrades({ userId, limit: '100' });
    const balanceItems = filtered.trades.filter(
      (trade) => trade.type === 'balance'
    );
    expect(balanceItems.map(({ id }) => id).sort()).toEqual(
      ledger.map(({ id }) => id).sort()
    );
    for (const row of ledger) {
      const item = balanceItems.find(({ id }) => id === row.id);
      expect(item?.transactionType).toBe(row.type);
      expect(item?.amount).toBe(row.amount);
      if (row.type.startsWith('pred_')) {
        if (row.relatedId === null)
          throw new Error('Prediction ledger is missing its market link');
        expect(item?.market?.id).toBe(row.relatedId);
      }
    }

    const another = await readTrades({ userId: anotherUserId, limit: '100' });
    expect(keys(another)).toContain(`balance:${unrelatedBalanceRow.id}`);
    const all = await readTrades({ limit: '100' });
    expect(keys(all).sort()).toEqual(
      [...keys(filtered), ...keys(another)].sort()
    );
    await expectPageWalk({ userId }, filtered);
    await expectPageWalk({}, all);
    console.info(
      'TRADE_HISTORY_HTTP_RESULT ' +
        JSON.stringify({
          route: '/api/trades',
          status: 200,
          tradeTypes: [...persistedTradeTypes].sort(),
          filtered: filtered.total,
          global: all.total,
        })
    );
  });
}

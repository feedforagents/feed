/** Funding-netted perp close display. PRD §9.3, MVP Phase 6. */
import { expect, test } from 'bun:test';
import type { PerpDbPort } from '@feed/core/markets/perps';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const fundedClose =
  'shows the funding-netted close PnL after five distinct periods';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the perp close display calculation on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'perp-close-dialog-funding',
      file: 'packages/testing/integration/perp-close-dialog-funding.integration.test.ts',
      cases: [fundedClose],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { PerpDbAdapter, PerpMarketService } = await import(
    '@feed/core/markets/perps'
  );
  const {
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositionFundingAccruals,
    users,
  } = await import('@feed/db');
  const { createPerpSettlement, createUserWalletAdapter, FEE_CONFIG } =
    await import('@feed/engine');
  const {
    calculateNetUnrealizedPnL,
    calculateUnrealizedPnL,
    generateSnowflakeId,
  } = await import('@feed/shared');

  // Limit the scheduled producer to the target market even inside the lease.
  class OwnedMarketDb extends PerpDbAdapter {
    constructor(private readonly ticker: string) {
      super();
    }

    async listMarkets() {
      return (await super.listMarkets()).filter(
        (row) => row.ticker === this.ticker
      );
    }

    async listOpenPositions() {
      return (await super.listOpenPositions()).filter(
        (row) => row.ticker === this.ticker
      );
    }
  }

  const openedAt = Date.UTC(2026, 0, 1);
  const periodMs = 8 * 60 * 60 * 1000;
  let now = new Date(openedAt);

  function serviceFor(adapter: PerpDbPort) {
    return new PerpMarketService({
      db: adapter,
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      clock: { now: () => now },
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    });
  }

  async function seedUser() {
    const id = await generateSnowflakeId();
    await db.insert(users).values({
      id,
      username: `close-dialog-${id}`,
      virtualBalance: '100000',
      totalDeposited: '100000',
      updatedAt: now,
    });
    return id;
  }

  async function seedMarket(ticker: string) {
    await db.transaction(async (tx) => {
      await tx.insert(organizationState).values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: now,
      });
      await tx.insert(perpMarketSnapshots).values({
        ticker,
        organizationId: ticker,
        currentPrice: 100,
        markPrice: 100,
        indexPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 0,
        volume24h: 7500000,
        bidDepth: 1000000,
        askDepth: 1000000,
        fundingRate: {
          ticker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: now.toISOString(),
        },
        metrics24hResetAt: now,
        price24hAgoUpdatedAt: now,
      });
    });
  }

  function snapshot(ticker: string) {
    return db.query.perpMarketSnapshots.findFirst({
      where: eq(perpMarketSnapshots.ticker, ticker),
    });
  }

  function accruals(positionId: string) {
    return db
      .select({ periodStart: perpPositionFundingAccruals.periodStart })
      .from(perpPositionFundingAccruals)
      .where(eq(perpPositionFundingAccruals.positionId, positionId))
      .orderBy(perpPositionFundingAccruals.periodStart);
  }

  test(fundedClose, async () => {
    const ticker = 'CLOSDLG';
    const foreignTicker = 'FRNDLG';
    const longUser = await seedUser();
    const shortUser = await seedUser();
    const foreignUser = await seedUser();
    await seedMarket(ticker);
    await seedMarket(foreignTicker);

    const adapter = new OwnedMarketDb(ticker);
    const service = serviceFor(adapter);
    const long = await service.openPosition({
      userId: longUser,
      ticker,
      side: 'long',
      size: 8_000,
      leverage: 10,
    });
    await service.openPosition({
      userId: shortUser,
      ticker,
      side: 'short',
      size: 10,
      leverage: 10,
    });
    const foreign = await serviceFor(new PerpDbAdapter()).openPosition({
      userId: foreignUser,
      ticker: foreignTicker,
      side: 'long',
      size: 1_000,
      leverage: 10,
    });
    const foreignMarketBefore = await snapshot(foreignTicker);
    const foreignPositionBefore = await adapter.getPositionById(
      foreign.positionId
    );
    expect(foreignMarketBefore).toBeDefined();
    expect(foreignPositionBefore?.fundingPaid).toBe(0);

    const periods: { periodStart: Date }[] = [];
    for (let step = 1; step <= 5; step++) {
      now = new Date(openedAt + step * periodMs);
      await service.processFundingStep(now);
      periods.push({ periodStart: now });
    }

    expect(await accruals(long.positionId)).toEqual(periods);
    expect(await accruals(foreign.positionId)).toEqual([]);
    expect(await snapshot(foreignTicker)).toEqual(foreignMarketBefore);
    expect(await adapter.getPositionById(foreign.positionId)).toEqual(
      foreignPositionBefore
    );

    const position = await adapter.getPositionById(long.positionId);
    if (!position) throw new Error('Missing funded fixture position');
    expect(position.fundingPaid).toBeGreaterThan(1);

    const closed = await service.closePosition({
      userId: longUser,
      positionId: position.id,
    });
    if (closed.exitPrice === undefined || closed.realizedPnL === undefined) {
      throw new Error('Missing settlement outcome for the funded position');
    }

    const { entryPrice, side, size, fundingPaid, currentPrice } = position;
    const priceOnly = calculateUnrealizedPnL(
      entryPrice,
      currentPrice,
      side,
      size
    );
    const netAtMark = calculateNetUnrealizedPnL(
      entryPrice,
      currentPrice,
      side,
      size,
      fundingPaid
    );
    expect(netAtMark.pnl).toBeCloseTo(priceOnly.pnl - fundingPaid, 2);
    expect(netAtMark.pnlPercent).toBeCloseTo((netAtMark.pnl / size) * 100, 2);

    const priceOnlyAtExit = calculateUnrealizedPnL(
      entryPrice,
      closed.exitPrice,
      side,
      size
    );
    expect(priceOnlyAtExit.pnl - closed.realizedPnL).toBeCloseTo(
      fundingPaid,
      2
    );
    const netAtExit = calculateNetUnrealizedPnL(
      entryPrice,
      closed.exitPrice,
      side,
      size,
      fundingPaid
    );
    expect(netAtExit.pnl).toBeCloseTo(closed.realizedPnL, 2);
  });
}

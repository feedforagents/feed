/**
 * Close-dialog funding: the web close confirmation must show the
 * funding-netted PnL, because closePosition settles realized PnL as
 * mark PnL less fundingPaid (PRD §9.3).
 *
 * The A2A portfolio view and the engine portfolio valuation already net
 * accrued funding out of displayed unrealized PnL (see
 * a2a-positions-funding); the web positions list and wallet tab showed
 * the price-only number in the close dialog instead, overstating what
 * the close realizes by exactly fundingPaid.
 *
 * Repro on base: this file fails to import — calculateNetUnrealizedPnL
 * does not exist — and the price-only dialog number differs from the
 * settled realized PnL by fundingPaid (measured $18.12 after five
 * 8-hour funding steps on a $8,000 long at near-max imbalance, while
 * pnl-at-exit less realized PnL equals fundingPaid to 10 decimals).
 *
 * Fixture scoping: the funding producer (processFundingStep) reads every
 * market and every open position, so the service under test runs behind an
 * owned-market adapter that filters listMarkets/listOpenPositions to this
 * fixture's ticker. A foreign market with its own open position is seeded
 * alongside and snapshotted before the funding steps to prove unrelated
 * rows stay untouched. Ownership is published only after each insert/open
 * commits, and cleanup deletes exactly the acquired ids; parent cleanup
 * refuses when a foreign position still references the ticker.
 */
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
import {
  calculateNetUnrealizedPnL,
  calculateUnrealizedPnL,
  generateSnowflakeId,
} from '@feed/shared';

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

const FEES = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

const makeService = (dbAdapter: PerpDbAdapter) =>
  new PerpMarketService({
    db: dbAdapter,
    wallet: createUserWalletAdapter(),
    settlement: createPerpSettlement(),
    fees: FEES,
  });

test('close dialog shows funding-netted PnL for a funded long', async () => {
  const userIds = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  const ticker = `CLOSDLG${userIds[0]}`;
  const foreignTicker = `FRNDLG${userIds[2]}`;
  // Ownership is published only after each insert/open commits: cleanup
  // deletes exactly these ids, never the generated ids themselves. The
  // foreign fixtures are seeded by this test too, so their rows are owned
  // here as well — they exist only to prove the producer leaves unrelated
  // rows alone.
  const acquired = {
    userIds: [] as string[],
    positionIds: [] as string[],
    tickers: [] as string[],
  };
  const adapter = new OwnedMarketDb(ticker);
  const service = makeService(adapter);
  // Plain adapter, used only to open the foreign seed position. It never
  // runs a funding step, so it mutates nothing outside the seed.
  const seeder = makeService(new PerpDbAdapter());
  try {
    const longUser = userIds[0]!;
    const shortUser = userIds[1]!;
    const foreignUser = userIds[2]!;
    for (const id of userIds) {
      await db.insert(users).values({
        id,
        username: `close-dlg-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        updatedAt: new Date(),
      });
      acquired.userIds.push(id);
    }
    for (const marketTicker of [ticker, foreignTicker]) {
      await db.insert(organizationState).values({
        id: marketTicker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: new Date(),
      });
      await db.insert(perpMarketSnapshots).values({
        ticker: marketTicker,
        organizationId: marketTicker,
        currentPrice: 100,
        markPrice: 100,
        indexPrice: 100,
        high24h: 100,
        low24h: 100,
        // Deep market so the execution spread stays small relative to
        // accrued funding; metrics24hResetAt keeps the first write from
        // rotating the seeded volume away.
        openInterest: 0,
        volume24h: 7500000,
        bidDepth: 1000000,
        askDepth: 1000000,
        fundingRate: {
          ticker: marketTicker,
          rate: 0,
          predictedRate: 0,
          nextFundingTime: new Date().toISOString(),
        },
        metrics24hResetAt: new Date(),
        price24hAgoUpdatedAt: new Date(),
      });
      acquired.tickers.push(marketTicker);
    }
    for (const [id, side, size] of [
      [longUser, 'long', 8000],
      [shortUser, 'short', 10],
    ] as const) {
      const opened = await service.openPosition({
        userId: id,
        ticker,
        side,
        size,
        leverage: 10,
      });
      acquired.positionIds.push(opened.positionId);
    }
    // Foreign market with a long-dominant book: a plain-adapter funding
    // step would accrue funding on this position and refresh this
    // market's funding terms, so it is the canary for producer scope.
    const foreignOpened = await seeder.openPosition({
      userId: foreignUser,
      ticker: foreignTicker,
      side: 'long',
      size: 1000,
      leverage: 10,
    });
    acquired.positionIds.push(foreignOpened.positionId);
    const [foreignMarketBefore] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, foreignTicker));
    const foreignBefore = await adapter.getPositionById(
      foreignOpened.positionId
    );
    expect(foreignMarketBefore).toBeDefined();
    expect(foreignBefore).not.toBeNull();
    expect(foreignBefore!.fundingPaid).toBe(0);

    // Five 8-hour funding steps (~40h held) at near-max imbalance.
    for (let step = 0; step < 5; step++) await service.processFundingStep();

    // The producer must not touch the foreign market or position.
    const [foreignMarketAfter] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, foreignTicker));
    const foreignAfter = await adapter.getPositionById(
      foreignOpened.positionId
    );
    expect(foreignMarketAfter?.fundingRate).toEqual(
      foreignMarketBefore?.fundingRate
    );
    expect(foreignAfter?.fundingPaid).toBe(0);

    const positions = await adapter.getOpenPositionsByUser(longUser);
    expect(positions).toHaveLength(1);
    const pos = positions[0]!;
    expect(pos.fundingPaid).toBeGreaterThan(1);

    // What the dialog showed before the fix: price-only, funding ignored.
    const dialogBefore = calculateUnrealizedPnL(
      pos.entryPrice,
      pos.currentPrice,
      pos.side,
      pos.size
    );

    const closed = await service.closePosition({
      userId: longUser,
      positionId: pos.id,
    });
    const exitPrice = closed.exitPrice ?? pos.currentPrice;

    // Premise: settlement nets funding exactly.
    const pnlAtExit = calculateUnrealizedPnL(
      pos.entryPrice,
      exitPrice,
      pos.side,
      pos.size
    ).pnl;
    expect(pnlAtExit - (closed.realizedPnL ?? 0)).toBeCloseTo(
      pos.fundingPaid,
      2
    );

    // The fix: the dialog number nets funding exactly the way the
    // settlement does, at any price — so the dialog value at the exit
    // price equals the settled realized PnL.
    expect(
      calculateNetUnrealizedPnL(
        pos.entryPrice,
        exitPrice,
        pos.side,
        pos.size,
        pos.fundingPaid
      ).pnl
    ).toBeCloseTo(closed.realizedPnL ?? 0, 2);

    // And at the mark the dialog shows the price-only number less funding.
    expect(
      calculateNetUnrealizedPnL(
        pos.entryPrice,
        pos.currentPrice,
        pos.side,
        pos.size,
        pos.fundingPaid
      ).pnl
    ).toBeCloseTo(dialogBefore.pnl - pos.fundingPaid, 2);
  } finally {
    // Delete only exact acquired effects. Ledger rows are keyed by owned
    // user ids, positions by acquired position ids.
    if (acquired.userIds.length > 0) {
      for (const table of [pointsTransactions, balanceTransactions])
        await db.delete(table).where(inArray(table.userId, acquired.userIds));
    }
    if (acquired.positionIds.length > 0)
      await db
        .delete(perpPositions)
        .where(inArray(perpPositions.id, acquired.positionIds));
    // Refuse parent cleanup while any position row outside the acquired
    // set still references the ticker: that row belongs to someone else.
    for (const marketTicker of acquired.tickers) {
      const rows = await db
        .select({ id: perpPositions.id })
        .from(perpPositions)
        .where(eq(perpPositions.ticker, marketTicker));
      const stray = rows.filter(
        (row) => !acquired.positionIds.includes(row.id)
      );
      if (stray.length > 0)
        throw new Error(
          `Refusing cleanup of market ${marketTicker}: ${stray.length} foreign position(s) still reference it`
        );
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, marketTicker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, marketTicker));
    }
    if (acquired.userIds.length > 0)
      await db.delete(users).where(inArray(users.id, acquired.userIds));
  }
});

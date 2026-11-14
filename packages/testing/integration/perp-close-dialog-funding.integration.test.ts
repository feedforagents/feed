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

test('close dialog shows funding-netted PnL for a funded long', async () => {
  const userIds = [await generateSnowflakeId(), await generateSnowflakeId()];
  const ticker = `CLOSDLG${userIds[0]}`;
  const adapter = new PerpDbAdapter();
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
      // Deep market so the execution spread stays small relative to
      // accrued funding; metrics24hResetAt keeps the first write from
      // rotating the seeded volume away.
      openInterest: 0,
      volume24h: 7500000,
      bidDepth: 1000000,
      askDepth: 1000000,
      fundingRate: {
        ticker,
        rate: 0,
        predictedRate: 0,
        nextFundingTime: new Date().toISOString(),
      },
      metrics24hResetAt: new Date(),
      price24hAgoUpdatedAt: new Date(),
    });
    const longUser = userIds[0]!;
    const shortUser = userIds[1]!;
    for (const [id, side, size] of [
      [longUser, 'long', 8000],
      [shortUser, 'short', 10],
    ] as const) {
      await db.insert(users).values({
        id,
        username: `close-dlg-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        updatedAt: new Date(),
      });
      await service.openPosition({
        userId: id,
        ticker,
        side,
        size,
        leverage: 10,
      });
    }
    // Five 8-hour funding steps (~40h held) at near-max imbalance.
    for (let step = 0; step < 5; step++) await service.processFundingStep();

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
    for (const table of [
      pointsTransactions,
      balanceTransactions,
      perpPositions,
    ])
      await db.delete(table).where(inArray(table.userId, userIds));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await db.delete(organizationState).where(eq(organizationState.id, ticker));
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

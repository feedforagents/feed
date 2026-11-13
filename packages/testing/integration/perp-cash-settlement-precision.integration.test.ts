/**
 * PRD §9.1 / MVP Phase 6: perp cash legs settle in whole hundredths in the
 * house's favor. Charges are never below the owed margin plus fee, credits are
 * never above the computed proceeds, and the persisted ledger matches the
 * balance change. Margin is size / leverage, so most opens and closes compute
 * sub-hundredth amounts that the numeric(18,2) balance would otherwise round to
 * the nearest hundredth, sometimes in the trader's favor. The P&L booked over
 * a round trip must equal the balance change, including that rounding.
 */
import { spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  and,
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
import { WalletService } from '@feed/engine';
import { floorPoints, isPointsAmount } from '@feed/shared';
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';

const STARTING_BALANCE = 10_000;

/** Smallest two-decimal amount that is not below `value`. */
function ceilPoints(value: number): number {
  if (isPointsAmount(value)) return value;
  return Math.round((floorPoints(value) + 0.01) * 100) / 100;
}

async function setPrice(ticker: string, price: number): Promise<void> {
  await db
    .update(organizationState)
    .set({ currentPrice: price, basePrice: price })
    .where(eq(organizationState.id, ticker));
  await db
    .update(perpMarketSnapshots)
    .set({ currentPrice: price })
    .where(eq(perpMarketSnapshots.ticker, ticker));
}

async function ledger(uid: string, type: string) {
  return db
    .select()
    .from(balanceTransactions)
    .where(
      and(
        eq(balanceTransactions.userId, uid),
        eq(balanceTransactions.type, type)
      )
    );
}

/**
 * `bookedPnL` returns the exact sum of the P&L deltas booked for the fixture
 * user. The calls still reach the database; the sum is read from them because
 * the lifetimePnL column rounds each write to a hundredth.
 */
async function withFixture(
  label: string,
  run: (uid: string, ticker: string, bookedPnL: () => number) => Promise<void>
): Promise<void> {
  const uid = `perp-cash-${label}-${crypto.randomUUID()}`;
  const ticker = `PCASH${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const recordPnL = spyOn(WalletService, 'recordPnL');
  const bookedPnL = () =>
    recordPnL.mock.calls
      .filter(([userId]) => userId === uid)
      .reduce((sum, [, pnl]) => sum + pnl, 0);
  try {
    await db.insert(users).values({
      id: uid,
      username: uid,
      virtualBalance: String(STARTING_BALANCE),
      totalDeposited: String(STARTING_BALANCE),
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
        nextFundingTime: new Date().toISOString(),
        predictedRate: 0,
      },
    });
    await run(uid, ticker, bookedPnL);
  } finally {
    recordPnL.mockRestore();
    await db
      .delete(pointsTransactions)
      .where(eq(pointsTransactions.userId, uid));
    await db
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, uid));
    await db.delete(perpPositions).where(eq(perpPositions.userId, uid));
    await db.delete(stockPrices).where(eq(stockPrices.organizationId, ticker));
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    await db.delete(organizationState).where(eq(organizationState.id, ticker));
    await db.delete(users).where(eq(users.id, uid));
  }
}

async function balanceOf(uid: string): Promise<number> {
  const [user] = await db.select().from(users).where(eq(users.id, uid));
  assert.ok(user);
  return Number(user.virtualBalance);
}

async function lifetimePnLOf(uid: string): Promise<number> {
  const [user] = await db.select().from(users).where(eq(users.id, uid));
  assert.ok(user);
  return Number(user.lifetimePnL);
}

const hundredths = (value: number) => Math.round(value * 100) / 100;

function assertBooked(booked: number, balanceChange: number, label: string) {
  assert.ok(
    Math.abs(booked - balanceChange) < 1e-9,
    `${label} booked P&L ${booked} for a balance change of ${balanceChange}`
  );
}

const roundTrips = [
  { size: 10, leverage: 3, exit: 101.37 },
  { size: 100, leverage: 3, exit: 98.61 },
  { size: 10, leverage: 7, exit: 102.05 },
  { size: 25, leverage: 6, exit: 99.17 },
] as const;

for (const { size, leverage, exit } of roundTrips) {
  for (const side of ['long', 'short'] as const) {
    test(`${side} ${size}@${leverage}x open charges and close credits settle to hundredths in the house's favor`, async () => {
      await withFixture(
        `rt-${side}-${size}-${leverage}`,
        async (uid, ticker, bookedPnL) => {
          const service = createPerpMarketService({ withPriceImpact: true });

          const opened = await service.openPosition({
            userId: uid,
            ticker,
            side,
            size,
            leverage,
          });
          const owed = (opened.marginPaid ?? 0) + opened.feePaid;
          const [openRow] = await ledger(uid, 'perp_open');
          assert.ok(openRow);
          const charged = -Number(openRow.amount);
          assert.ok(
            charged >= owed,
            `open charged ${charged} for ${owed} owed (margin ${opened.marginPaid} + fee ${opened.feePaid})`
          );
          assert.equal(charged, ceilPoints(owed));
          assert.equal(await balanceOf(uid), STARTING_BALANCE - charged);

          await setPrice(ticker, exit);
          const closed = await service.closePosition({
            userId: uid,
            positionId: opened.positionId,
          });
          assert.equal(closed.fullyClosed, true);
          const proceeds = Math.max(
            0,
            (closed.marginPaid ?? 0) +
              (closed.realizedPnL ?? 0) -
              closed.feePaid
          );
          const [closeRow] = await ledger(uid, 'perp_close');
          assert.ok(closeRow);
          const credited = Number(closeRow.amount);
          assert.ok(
            credited <= proceeds,
            `close credited ${credited} for ${proceeds} of proceeds`
          );
          assert.equal(credited, floorPoints(proceeds));
          assert.equal(
            await balanceOf(uid),
            hundredths(STARTING_BALANCE - charged + credited)
          );
          assertBooked(bookedPnL(), credited - charged, 'round trip');
          assert.equal(
            await lifetimePnLOf(uid),
            hundredths(credited - charged)
          );
        }
      );
    });
  }
}

test('splitting a close into partial closes never credits more than the proceeds of each leg', async () => {
  await withFixture('split', async (uid, ticker, bookedPnL) => {
    const service = createPerpMarketService({ withPriceImpact: true });
    const opened = await service.openPosition({
      userId: uid,
      ticker,
      side: 'long',
      size: 100,
      leverage: 3,
    });
    await setPrice(ticker, 101.37);

    let totalProceeds = 0;
    for (const percentage of [0.5, 1]) {
      const leg = await service.closePosition({
        userId: uid,
        positionId: opened.positionId,
        percentage,
      });
      totalProceeds += Math.max(
        0,
        (leg.marginPaid ?? 0) + (leg.realizedPnL ?? 0) - leg.feePaid
      );
    }

    const rows = [
      ...(await ledger(uid, 'perp_partial_close')),
      ...(await ledger(uid, 'perp_close')),
    ];
    assert.equal(rows.length, 2);
    const credited = rows.reduce((sum, row) => sum + Number(row.amount), 0);
    assert.ok(
      credited <= totalProceeds,
      `split close credited ${credited} for ${totalProceeds} of proceeds`
    );
    for (const row of rows) {
      assert.ok(isPointsAmount(Number(row.amount)));
    }
    assertBooked(
      bookedPnL(),
      (await balanceOf(uid)) - STARTING_BALANCE,
      'split round trip'
    );
  });
});

test('adding to and flipping a position books the rounding of every opening charge', async () => {
  await withFixture('add-flip', async (uid, ticker, bookedPnL) => {
    const service = createPerpMarketService({ withPriceImpact: true });
    const trade = (side: 'long' | 'short', size: number) =>
      service.openPosition({ userId: uid, ticker, side, size, leverage: 3 });

    await trade('long', 10);
    const added = await trade('long', 11);
    assert.equal(added.rebalanceType, 'add');
    await setPrice(ticker, 101.37);
    const flipped = await trade('short', 35);
    assert.equal(flipped.rebalanceType, 'flip');
    await setPrice(ticker, 99.17);
    const closed = await service.closePosition({
      userId: uid,
      positionId: flipped.positionId,
    });
    assert.equal(closed.fullyClosed, true);

    assertBooked(
      bookedPnL(),
      (await balanceOf(uid)) - STARTING_BALANCE,
      'open, add, flip and close'
    );
  });
});

/**
 * PRD §8.2 (portfolio P&L) and §9.3 (perp rebuild) / MVP Phase 6: adding to a
 * perp position must blend the entry so the preview, the stored position, the
 * realized P&L and the wallet all agree with the units each leg bought.
 */
import { expect, test } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  stockPrices,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';
import {
  applyUserTradePriceImpact,
  createPerpMarketService,
} from '../../../apps/web/src/app/api/markets/perps/_adapters';
import { POST as previewRoute } from '../../../apps/web/src/app/api/markets/perps/preview/route';

type Side = 'long' | 'short';
const ip = crypto.getRandomValues(new Uint8Array(2));
const clientIp = `198.19.${ip[0]}.${ip[1]}`;

const START_BALANCE = 10_000;

async function setupMarket(userId: string, ticker: string) {
  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username: userId,
      virtualBalance: String(START_BALANCE),
      totalDeposited: String(START_BALANCE),
      lifetimePnL: '0',
      updatedAt: new Date(),
    });
    await tx.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt: new Date(),
    });
    await tx.insert(perpMarketSnapshots).values({
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
  });
}

async function cleanup(userId: string, ticker: string) {
  await dbWrite
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await dbWrite
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await dbWrite.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await dbWrite
    .delete(stockPrices)
    .where(eq(stockPrices.organizationId, ticker));
  await dbWrite
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await dbWrite
    .delete(organizationState)
    .where(eq(organizationState.id, ticker));
  await dbWrite.delete(users).where(eq(users.id, userId));
}

/** Moves the AMM pool to a new base price, the way price ticks do. */
async function moveMarket(ticker: string, basePrice: number) {
  await dbWrite
    .update(organizationState)
    .set({ basePrice, currentPrice: basePrice })
    .where(eq(organizationState.id, ticker));
  await applyUserTradePriceImpact(ticker);
}

async function previewAdd(
  userId: string,
  body: { ticker: string; side: Side; size: number; leverage: number }
) {
  const previous = process.env.ALLOW_TEST_PRIVY_DID_AUTH;
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
  try {
    const response = await previewRoute(
      new NextRequest('http://localhost/api/markets/perps/preview', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': clientIp,
          authorization: `Bearer steward:test:${userId}`,
        },
        body: JSON.stringify(body),
      })
    );
    expect(response.status).toBe(200);
    return (await response.json()).preview;
  } finally {
    if (previous === undefined) delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    else process.env.ALLOW_TEST_PRIVY_DID_AUTH = previous;
  }
}

async function readUser(userId: string) {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error(`user ${userId} missing`);
  return user;
}

async function readPosition(positionId: string) {
  const [position] = await dbWrite
    .select()
    .from(perpPositions)
    .where(eq(perpPositions.id, positionId));
  if (!position) throw new Error(`position ${positionId} missing`);
  return position;
}

/** P&L of selling `units` (or buying them back, for a short) at `exit`. */
function legPnL(side: Side, units: number, cost: number, exit: number) {
  return side === 'long' ? units * exit - cost : cost - units * exit;
}

const cases = [
  // Long averages down, then partly recovers. Short adds higher, then eases.
  { side: 'long', addAt: 80, partialAt: 90, finalAt: 95 },
  { side: 'short', addAt: 120, partialAt: 110, finalAt: 105 },
] as const;

for (const { side, addAt, partialAt, finalAt } of cases) {
  test(`${side} add: preview, stored entry, P&L and wallet reconcile`, async () => {
    const userId = `add-entry-${crypto.randomUUID()}`;
    const ticker = `ADDENTRY${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await setupMarket(userId, ticker);
    try {
      const service = createPerpMarketService({ withPriceImpact: true });

      const opened = await service.openPosition({
        userId,
        ticker,
        side,
        size: 1000,
        leverage: 2,
      });
      const firstFill = opened.fillPrice ?? opened.entryPrice;

      await moveMarket(ticker, addAt);
      const beforeAdd = await readUser(userId);
      const preview = await previewAdd(userId, {
        ticker,
        side,
        size: 1000,
        leverage: 2,
      });
      expect(preview.rebalanceType).toBe('add');
      expect((await readUser(userId)).virtualBalance).toBe(
        beforeAdd.virtualBalance
      );

      const added = await service.openPosition({
        userId,
        ticker,
        side,
        size: 1000,
        leverage: 2,
      });
      const addFill = added.fillPrice;
      if (addFill === undefined) throw new Error('add returned no fillPrice');
      const afterAdd = await readUser(userId);

      // Preview quoted what execution did.
      expect(preview.executionPrice).toBeCloseTo(addFill, 6);
      expect(preview.liquidationPrice).toBeCloseTo(added.liquidationPrice, 6);
      const addDebit =
        Number(beforeAdd.virtualBalance) - Number(afterAdd.virtualBalance);
      expect(Math.abs(preview.totalRequired - addDebit)).toBeLessThan(0.01);

      // Stored entry is total points over total units held.
      const units = 1000 / firstFill + 1000 / addFill;
      const stored = await readPosition(opened.positionId);
      expect(stored.size).toBeCloseTo(2000, 6);
      expect(stored.entryPrice).toBeCloseTo(2000 / units, 6);
      expect(added.entryPrice).toBeCloseTo(stored.entryPrice, 6);
      // The old points-weighted blend is measurably different here.
      expect(
        Math.abs((firstFill + addFill) / 2 - stored.entryPrice)
      ).toBeGreaterThan(0.5);

      // Close half, then the rest, at two different prices.
      await moveMarket(ticker, partialAt);
      const half = await service.closePosition({
        userId,
        positionId: opened.positionId,
        percentage: 0.5,
      });
      await moveMarket(ticker, finalAt);
      const rest = await service.closePosition({
        userId,
        positionId: opened.positionId,
      });
      if (half.exitPrice === undefined || rest.exitPrice === undefined)
        throw new Error('close returned no exitPrice');

      // Each half of the position holds half the units of both legs.
      expect(half.realizedPnL).toBeCloseTo(
        legPnL(side, units / 2, 1000, half.exitPrice),
        6
      );
      expect(rest.realizedPnL).toBeCloseTo(
        legPnL(side, units / 2, 1000, rest.exitPrice),
        6
      );
      expect(rest.fullyClosed).toBe(true);

      const closed = await readPosition(opened.positionId);
      const realized = (half.realizedPnL ?? 0) + (rest.realizedPnL ?? 0);
      expect(closed.closedAt).not.toBeNull();
      expect(closed.realizedPnL).toBeCloseTo(realized, 6);

      // Wallet: every point that moved is a fee or realized P&L. Balances
      // are stored in cents after each of the four trades, so allow 2 cents.
      const fees = opened.feePaid + added.feePaid + half.feePaid + rest.feePaid;
      const user = await readUser(userId);
      const walletDelta = Number(user.virtualBalance) - START_BALANCE;
      expect(Math.abs(walletDelta - (realized - fees))).toBeLessThan(0.02);
      expect(
        Math.abs(Number(user.lifetimePnL) - (realized - fees))
      ).toBeLessThan(0.02);
      const ledger = await dbWrite
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, userId));
      const ledgerNet = ledger.reduce(
        (sum, row) => sum + Number(row.amount),
        0
      );
      expect(Math.abs(ledgerNet - walletDelta)).toBeLessThan(0.02);
    } finally {
      await cleanup(userId, ticker);
    }
  });
}

test('position stored with a legacy blended entry keeps it and blends on top', async () => {
  const userId = `add-entry-legacy-${crypto.randomUUID()}`;
  const ticker = `ADDLEGACY${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await setupMarket(userId, ticker);
  try {
    // What the old formula stored for long 1000 @ 100 plus 1000 @ 80.
    const legacyEntry = 90;
    const positionId = `legacy-${crypto.randomUUID()}`;
    await dbWrite.insert(perpPositions).values({
      id: positionId,
      userId,
      ticker,
      organizationId: ticker,
      side: 'long',
      entryPrice: legacyEntry,
      currentPrice: 100,
      size: 2000,
      leverage: 2,
      liquidationPrice: 46,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      lastUpdated: new Date(),
    });
    await dbWrite
      .update(users)
      .set({ virtualBalance: String(START_BALANCE - 1000) })
      .where(eq(users.id, userId));
    await moveMarket(ticker, 95);

    const service = createPerpMarketService({ withPriceImpact: true });
    const preview = await previewAdd(userId, {
      ticker,
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    expect((await readPosition(positionId)).entryPrice).toBe(legacyEntry);

    const added = await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    const addFill = added.fillPrice;
    if (addFill === undefined) throw new Error('add returned no fillPrice');
    expect(added.positionId).toBe(positionId);
    expect(preview.executionPrice).toBeCloseTo(addFill, 6);
    expect(preview.liquidationPrice).toBeCloseTo(added.liquidationPrice, 6);

    // The legacy entry is used as stored: 2000 points at 90 plus 1000 at the fill.
    const units = 2000 / legacyEntry + 1000 / addFill;
    const stored = await readPosition(positionId);
    expect(stored.entryPrice).toBeCloseTo(3000 / units, 6);

    const closed = await service.closePosition({ userId, positionId });
    if (closed.exitPrice === undefined)
      throw new Error('close returned no exitPrice');
    expect(closed.realizedPnL).toBeCloseTo(
      legPnL('long', units, 3000, closed.exitPrice),
      6
    );
  } finally {
    await cleanup(userId, ticker);
  }
});

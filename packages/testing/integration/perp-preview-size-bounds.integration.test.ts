/** PRD §9.3 / MVP Phase 6: the preview must quote only orders the open flow accepts. */
import { expect, test } from 'bun:test';
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
import { createPerpMarketService } from '../../../apps/web/src/app/api/markets/perps/_adapters';

/**
 * Ownership acquired by a seed. Proposed fixture IDs do not establish
 * ownership; only rows a committed seed actually RETURNING-acquired do.
 * Cleanup deletes nothing without this receipt, so a failed seed can
 * never authorize deleting pre-existing rows.
 */
type OwnedFixture = { userId: string; ticker: string };

async function seedMarket(
  userId: string,
  ticker: string
): Promise<OwnedFixture> {
  return await db.transaction(async (tx) => {
    const userRows = await tx
      .insert(users)
      .values({
        id: userId,
        username: userId,
        virtualBalance: '1000000',
        totalDeposited: '1000000',
        lifetimePnL: '0',
        updatedAt: new Date(),
      })
      .returning();
    if (userRows.length !== 1) throw new Error('Incomplete Users RETURNING');
    const orgRows = await tx
      .insert(organizationState)
      .values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: new Date(),
      })
      .returning();
    if (orgRows.length !== 1)
      throw new Error('Incomplete OrganizationState RETURNING');
    const snapshotRows = await tx
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
      .returning();
    if (snapshotRows.length !== 1)
      throw new Error('Incomplete PerpMarketSnapshots RETURNING');
    return { userId, ticker };
  });
}

async function cleanup(owned: OwnedFixture | null) {
  if (!owned) return;
  const { userId, ticker } = owned;
  await db.transaction(async (tx) => {
    // Attributable children first; parents only after their children
    // are confirmed gone, so a still-referenced parent stays in place
    // instead of widening the delete to make cleanup pass.
    await tx
      .delete(pointsTransactions)
      .where(eq(pointsTransactions.userId, userId));
    await tx
      .delete(balanceTransactions)
      .where(eq(balanceTransactions.userId, userId));
    await tx.delete(perpPositions).where(eq(perpPositions.userId, userId));
    await tx.delete(stockPrices).where(eq(stockPrices.organizationId, ticker));
    await tx
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    const [remainingPosition] = await tx
      .select({ id: perpPositions.id })
      .from(perpPositions)
      .where(eq(perpPositions.userId, userId))
      .limit(1);
    if (remainingPosition)
      throw new Error('Cleanup refused: position rows remain for owned user');
    const [remainingSnapshot] = await tx
      .select({ ticker: perpMarketSnapshots.ticker })
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker))
      .limit(1);
    if (remainingSnapshot)
      throw new Error('Cleanup refused: snapshot rows remain for owned ticker');
    await tx.delete(organizationState).where(eq(organizationState.id, ticker));
    await tx.delete(users).where(eq(users.id, userId));
  });
}

function tickerFor(prefix: string) {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
}

test('preview rejects a fresh open below the minimum order size, like open does', async () => {
  const userId = `preview-min-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVMIN');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    await expect(
      service.openPosition({
        userId,
        ticker,
        side: 'long',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
    await expect(
      service.previewOpenPosition({
        ticker,
        side: 'long',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
    await expect(
      service.previewOrder({
        userId,
        ticker,
        side: 'long',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
  } finally {
    await cleanup(owned);
  }
});

test('preview rejects a fresh open above the market size limit, like open does', async () => {
  const userId = `preview-max-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVMAX');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    // openInterest 0 → max position size is the 10,000 floor.
    await expect(
      service.openPosition({
        userId,
        ticker,
        side: 'long',
        size: 20000,
        leverage: 2,
      })
    ).rejects.toThrow('Order size exceeds market limit');
    await expect(
      service.previewOpenPosition({
        ticker,
        side: 'long',
        size: 20000,
        leverage: 2,
      })
    ).rejects.toThrow('Order size exceeds market limit');
    await expect(
      service.previewOrder({
        userId,
        ticker,
        side: 'long',
        size: 20000,
        leverage: 2,
      })
    ).rejects.toThrow('Order size exceeds market limit');
  } finally {
    await cleanup(owned);
  }
});

test('preview rejects a same-side add below the minimum order size, like open does', async () => {
  const userId = `preview-add-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVADD');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    await expect(
      service.openPosition({
        userId,
        ticker,
        side: 'long',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
    await expect(
      service.previewOrder({
        userId,
        ticker,
        side: 'long',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
  } finally {
    await cleanup(owned);
  }
});

test('preview rejects an opposite-side reduce below the minimum order size, like open does', async () => {
  const userId = `preview-reduce-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVRED');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    await expect(
      service.openPosition({
        userId,
        ticker,
        side: 'short',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
    await expect(
      service.previewOrder({
        userId,
        ticker,
        side: 'short',
        size: 5,
        leverage: 2,
      })
    ).rejects.toThrow('Order size below minimum (10)');
  } finally {
    await cleanup(owned);
  }
});

test('preview rejects an opposite-side flip above the market size limit, like open does', async () => {
  const userId = `preview-flip-max-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVFLIPMAX');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    await service.openPosition({
      userId,
      ticker,
      side: 'long',
      size: 1000,
      leverage: 2,
    });
    // openInterest 0 → max position size is the 10,000 floor, so the
    // 20,000-point short exceeds it even though the 19,000-point flip
    // leg clears the minimum on its own.
    await expect(
      service.openPosition({
        userId,
        ticker,
        side: 'short',
        size: 20000,
        leverage: 2,
      })
    ).rejects.toThrow('Order size exceeds market limit');
    await expect(
      service.previewOrder({
        userId,
        ticker,
        side: 'short',
        size: 20000,
        leverage: 2,
      })
    ).rejects.toThrow('Order size exceeds market limit');
  } finally {
    await cleanup(owned);
  }
});

test('preview still quotes a valid-size order (control)', async () => {
  const userId = `preview-ok-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVOK');
  const service = createPerpMarketService({ withPriceImpact: true });
  let owned: OwnedFixture | null = null;
  try {
    owned = await seedMarket(userId, ticker);
    const preview = await service.previewOrder({
      userId,
      ticker,
      side: 'long',
      size: 100,
      leverage: 2,
    });
    expect(preview).toBeDefined();
    expect(Number.isFinite(preview.totalRequired)).toBe(true);
  } finally {
    await cleanup(owned);
  }
});

test('a failed seed acquisition deletes nothing it did not create (preservation control)', async () => {
  const userId = `preview-preserve-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVPRES');
  const sentinel = await seedMarket(userId, ticker);
  try {
    // A second seed for the same ids fails on the users primary key, so
    // no ownership is acquired for the retry.
    await expect(seedMarket(userId, ticker)).rejects.toThrow();
    // Cleanup without ownership must leave the pre-existing rows alone.
    await cleanup(null);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user).toBeDefined();
    const [org] = await db
      .select()
      .from(organizationState)
      .where(eq(organizationState.id, ticker));
    expect(org).toBeDefined();
    const [snapshot] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
    expect(snapshot).toBeDefined();
  } finally {
    await cleanup(sentinel);
  }
});

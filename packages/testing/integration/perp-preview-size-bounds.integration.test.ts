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

async function seedMarket(userId: string, ticker: string) {
  await db.insert(users).values({
    id: userId,
    username: userId,
    virtualBalance: '1000000',
    totalDeposited: '1000000',
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
}

async function cleanup(userId: string, ticker: string) {
  await db
    .delete(pointsTransactions)
    .where(eq(pointsTransactions.userId, userId));
  await db
    .delete(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  await db.delete(perpPositions).where(eq(perpPositions.userId, userId));
  await db.delete(stockPrices).where(eq(stockPrices.organizationId, ticker));
  await db
    .delete(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  await db.delete(organizationState).where(eq(organizationState.id, ticker));
  await db.delete(users).where(eq(users.id, userId));
}

function tickerFor(prefix: string) {
  return `${prefix}${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
}

test('preview rejects a fresh open below the minimum order size, like open does', async () => {
  const userId = `preview-min-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVMIN');
  const service = createPerpMarketService({ withPriceImpact: true });
  try {
    await seedMarket(userId, ticker);
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
    await cleanup(userId, ticker);
  }
});

test('preview rejects a fresh open above the market size limit, like open does', async () => {
  const userId = `preview-max-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVMAX');
  const service = createPerpMarketService({ withPriceImpact: true });
  try {
    await seedMarket(userId, ticker);
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
    await cleanup(userId, ticker);
  }
});

test('preview rejects a same-side add below the minimum order size, like open does', async () => {
  const userId = `preview-add-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVADD');
  const service = createPerpMarketService({ withPriceImpact: true });
  try {
    await seedMarket(userId, ticker);
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
    await cleanup(userId, ticker);
  }
});

test('preview rejects an opposite-side reduce below the minimum order size, like open does', async () => {
  const userId = `preview-reduce-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVRED');
  const service = createPerpMarketService({ withPriceImpact: true });
  try {
    await seedMarket(userId, ticker);
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
    await cleanup(userId, ticker);
  }
});

test('preview still quotes a valid-size order (control)', async () => {
  const userId = `preview-ok-${crypto.randomUUID()}`;
  const ticker = tickerFor('PREVOK');
  const service = createPerpMarketService({ withPriceImpact: true });
  try {
    await seedMarket(userId, ticker);
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
    await cleanup(userId, ticker);
  }
});

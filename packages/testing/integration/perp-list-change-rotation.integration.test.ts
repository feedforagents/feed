/**
 * Integration test: perp list 24h change across the daily reference rotation
 *
 * The perp markets list shows (and sorts by) changePercent24h from the
 * snapshot row, whose own definition is change24h = currentPrice -
 * price24hAgo. Once per 24h the adapter rotates price24hAgo to the pre-write
 * current price. This test drives the real service price path against a real
 * database and checks that the rotation write keeps the row self-consistent:
 * the stored change must be measured from the reference the same write
 * installs, not from the previous window's reference.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { db, eq, perpMarketSnapshots } from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';

const fees = {
  tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
  platformShare: FEE_CONFIG.PLATFORM_SHARE,
  referrerShare: FEE_CONFIG.REFERRER_SHARE,
  minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
};

const tickers: string[] = [];

function makeService() {
  return new PerpMarketService({
    db: new PerpDbAdapter(),
    wallet: createUserWalletAdapter(),
    settlement: createPerpSettlement(),
    fees,
  });
}

async function seedMarket(input: {
  price24hAgoUpdatedAt: Date;
}): Promise<string> {
  const ticker = `F143${Date.now().toString(36).toUpperCase()}${tickers.length}`;
  tickers.push(ticker);
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: `org-${ticker.toLowerCase()}`,
    currentPrice: 120,
    price24hAgo: 100,
    price24hAgoUpdatedAt: input.price24hAgoUpdatedAt,
    metrics24hResetAt: new Date(),
    change24h: 20,
    changePercent24h: 20,
    high24h: 130,
    low24h: 95,
    volume24h: 0,
    openInterest: 0,
    fundingRate: {
      ticker,
      rate: 0,
      nextFundingTime: new Date().toISOString(),
      predictedRate: 0,
    },
  });
  return ticker;
}

async function readRow(ticker: string) {
  const [row] = await db
    .select()
    .from(perpMarketSnapshots)
    .where(eq(perpMarketSnapshots.ticker, ticker));
  return row;
}

afterAll(async () => {
  for (const ticker of tickers) {
    await db
      .delete(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ticker));
  }
});

describe('perp list 24h change across reference rotation', () => {
  it('measures the rotation-write change from the reference that write installs', async () => {
    const service = makeService();
    const ticker = await seedMarket({
      price24hAgoUpdatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const summary = await service.applyPriceUpdates({ [ticker]: 121 });
    expect(summary.errors).toEqual([]);
    expect(summary.marketsUpdated).toBe(1);

    const row = await readRow(ticker);
    // The rotation installs the pre-write price (120) as the new reference.
    expect(Number(row?.price24hAgo)).toBe(120);
    // The stored change must be measured from that same reference:
    // 121 - 120 = 1, not 121 - 100 = 21 (the previous window's reference).
    expect(Number(row?.change24h)).toBe(1);
    expect(Number(row?.changePercent24h)).toBeCloseTo(100 / 120, 6);
  });

  it('keeps measuring from the installed reference on the next update', async () => {
    const service = makeService();
    const ticker = await seedMarket({
      price24hAgoUpdatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await service.applyPriceUpdates({ [ticker]: 121 });
    const summary = await service.applyPriceUpdates({ [ticker]: 122 });
    expect(summary.errors).toEqual([]);

    const row = await readRow(ticker);
    expect(Number(row?.price24hAgo)).toBe(120);
    expect(Number(row?.change24h)).toBe(2);
    expect(Number(row?.changePercent24h)).toBeCloseTo(200 / 120, 6);
  });

  it('leaves non-rotation updates measured from the standing reference', async () => {
    const service = makeService();
    const ticker = await seedMarket({
      price24hAgoUpdatedAt: new Date(),
    });

    const summary = await service.applyPriceUpdates({ [ticker]: 121 });
    expect(summary.errors).toEqual([]);

    const row = await readRow(ticker);
    expect(Number(row?.price24hAgo)).toBe(100);
    expect(Number(row?.change24h)).toBe(21);
    expect(Number(row?.changePercent24h)).toBeCloseTo(21, 6);
  });
});

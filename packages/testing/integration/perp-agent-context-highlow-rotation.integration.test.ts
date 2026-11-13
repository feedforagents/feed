/**
 * Integration test (F145): perp snapshot 24h high/low across the daily
 * metrics rotation, as consumed by the NPC/agent decision context.
 *
 * The snapshot row's high24h/low24h are the current 24h window's extremes:
 * computeSnapshotRotation documents "high/low/volume reset once per 24h",
 * PerpDbAdapter.applyMarketDeltas resets them unconditionally to
 * rotation.resetPrice, and updateMarketStats' own fallback
 * (`updates.high24h ?? rotation.resetPrice`) states the same intent.
 * The live decision pipeline (npc-tick → MultiStepExecutor) reads these
 * fields through getMarketTrends, which renders the 24h range into the
 * decision prompt and derives volatility24h = (high − low) / price.
 * This test drives the real service price path against a real database
 * and measures what the rotation write stores — and what the decision
 * context then serves — when the price sweep passes caller-computed
 * extremes from the previous window.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import { db, eq, perpMarketSnapshots } from '@feed/db';
import {
  createPerpSettlement,
  createUserWalletAdapter,
  FEE_CONFIG,
} from '@feed/engine';
import { getMarketTrends } from '../../agents/src/autonomous/utils/context-gatherers';

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

async function seedMarket(input: { metrics24hResetAt: Date }): Promise<string> {
  const ticker = `F145${Date.now().toString(36).toUpperCase()}${tickers.length}`;
  tickers.push(ticker);
  await db.insert(perpMarketSnapshots).values({
    ticker,
    organizationId: `org-${ticker.toLowerCase()}`,
    currentPrice: 120,
    // Price reference rotation NOT due (recent) so only the metrics
    // rotation axis is exercised.
    price24hAgo: 100,
    price24hAgoUpdatedAt: new Date(),
    metrics24hResetAt: input.metrics24hResetAt,
    change24h: 20,
    changePercent24h: 20,
    // Previous window's extremes.
    high24h: 200,
    low24h: 50,
    volume24h: 5000,
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

describe('perp snapshot 24h high/low across metrics rotation (agent context)', () => {
  it('starts the new window at the rotation write price, not the old extremes', async () => {
    const service = makeService();
    const ticker = await seedMarket({
      metrics24hResetAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const summary = await service.applyPriceUpdates({ [ticker]: 121 });
    expect(summary.errors).toEqual([]);
    expect(summary.marketsUpdated).toBe(1);

    const row = await readRow(ticker);
    // The rotation resets volume in the same write (already correct).
    expect(Number(row?.volume24h)).toBe(0);
    // The new window has seen only the rotation write's price (121).
    expect(Number(row?.high24h)).toBe(121);
    expect(Number(row?.low24h)).toBe(121);
  });

  it('serves the decision context a fresh-window range and volatility after rotation', async () => {
    const service = makeService();
    const ticker = await seedMarket({
      metrics24hResetAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const summary = await service.applyPriceUpdates({ [ticker]: 121 });
    expect(summary.errors).toEqual([]);
    expect(summary.marketsUpdated).toBe(1);

    const trends = await getMarketTrends();
    const trend = trends.find((t) => t.ticker === ticker);
    expect(trend).toBeDefined();
    // The decision context renders this range and volatility into the
    // NPC/agent decision prompt. The new window has seen only 121.
    expect(trend?.high24h).toBe(121);
    expect(trend?.low24h).toBe(121);
    expect(trend?.volatility24h).toBe(0);
  });

  it('keeps accumulating extremes on non-rotation updates', async () => {
    const service = makeService();
    const ticker = await seedMarket({ metrics24hResetAt: new Date() });

    const summary = await service.applyPriceUpdates({ [ticker]: 121 });
    expect(summary.errors).toEqual([]);
    expect(summary.marketsUpdated).toBe(1);

    const row = await readRow(ticker);
    expect(Number(row?.high24h)).toBe(200);
    expect(Number(row?.low24h)).toBe(50);
    expect(Number(row?.volume24h)).toBe(5000);
  });

  it('resets high/low on the delta path for the same fixture (adapter contrast)', async () => {
    const adapter = new PerpDbAdapter();
    const ticker = await seedMarket({
      metrics24hResetAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    await adapter.applyMarketDeltas(ticker, { volume24h: 10 });

    const row = await readRow(ticker);
    // Delta path: resetPrice = standing current price (120).
    expect(Number(row?.high24h)).toBe(120);
    expect(Number(row?.low24h)).toBe(120);
    expect(Number(row?.volume24h)).toBe(10);
  });
});

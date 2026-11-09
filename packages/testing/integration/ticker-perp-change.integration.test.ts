/**
 * GET /api/ticker (perps stream) against a real database: the 24h change the
 * ticker shows for a perp must be the snapshot's canonical changePercent24h —
 * the same value GET /api/markets/perps returns ("single source of truth",
 * PerpMarketService.getMarketsSnapshot).
 *
 * The snapshot row carries both the stored changePercent24h (written by the
 * price tick against the 24h reference price) and price24hAgo. The reference
 * rotates to the current price once a day, and the rotation happens inside
 * every updateMarketStats / applyMarketDeltas write (funding updates, quote
 * refreshes, ordinary trades) — none of which recompute changePercent24h.
 * After a rotation the stored change still describes the move since the old
 * reference, while a recompute from (currentPrice, price24hAgo) collapses to
 * 0%. The ticker recomputed instead of reading the stored field, so right
 * after any rotation-triggering write it showed 0% for a market every other
 * surface showed at its real change.
 *
 * The rotation below is driven through the real PerpDbAdapter write path
 * (the funding-style updateMarketStats call), and both public routes are
 * called for real. The only stub is the `server-only` marker package.
 *
 * Fixture ownership: each fixture row is inserted on its own with
 * `.returning()`, and only IDs the database confirms as inserted are
 * recorded as owned. Cleanup deletes exactly those IDs, so a failed or
 * colliding setup can never delete a snapshot or market this suite never
 * created. A random suffix does not establish ownership.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { PerpDbAdapter } from '@feed/core/markets/perps';
import { PredictionPricing } from '@feed/core/markets/prediction';
import { db, eq, inArray, markets, perpMarketSnapshots } from '@feed/db';
import { NextRequest } from 'next/server';

type TickerPerp = {
  ticker: string;
  price: number;
  changePercent24h: number | null;
};
type ListMarket = { ticker: string; changePercent24h: number };

let tickerGET: typeof import('../../../apps/web/src/app/api/ticker/route').GET;
let perpsGET: typeof import('../../../apps/web/src/app/api/markets/perps/route').GET;

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const ROT = `F53ROT${suffix}`;
const STEADY = `F53STD${suffix}`;
const FRESH = `F53NEW${suffix}`;
const ZERO = `F53ZERO${suffix}`;

// Tickers / ids the database confirmed as inserted by this suite. Cleanup
// deletes exactly these — never the pre-generated ids, which may belong to
// nobody (or somebody else) when an insert fails.
const ownedSnapshotTickers: string[] = [];
const ownedMarketIds: string[] = [];

const fundingRate = (ticker: string) => ({
  ticker,
  rate: 0,
  predictedRate: 0,
  nextFundingTime: new Date().toISOString(),
});

type SnapshotFixture = {
  ticker: string;
  currentPrice: number;
  price24hAgo: number | null;
  price24hAgoUpdatedAt: Date | null;
  changePercent24h: number;
};

function snapshotValues(values: SnapshotFixture) {
  return {
    ticker: values.ticker,
    organizationId: values.ticker,
    currentPrice: values.currentPrice,
    price24hAgo: values.price24hAgo,
    price24hAgoUpdatedAt: values.price24hAgoUpdatedAt,
    metrics24hResetAt: new Date(),
    change24h: values.price24hAgo
      ? values.currentPrice - values.price24hAgo
      : 0,
    changePercent24h: values.changePercent24h,
    high24h: values.currentPrice,
    low24h: values.price24hAgo ?? values.currentPrice,
    volume24h: 0,
    openInterest: 0,
    fundingRate: fundingRate(values.ticker),
  };
}

// One INSERT per fixture with RETURNING: if a later insert fails, only the
// tickers the database confirmed are owned (and cleaned); the failed
// ticker never is.
async function insertSnapshot(values: SnapshotFixture): Promise<string> {
  const [row] = await db
    .insert(perpMarketSnapshots)
    .values(snapshotValues(values))
    .returning({ ticker: perpMarketSnapshots.ticker });
  if (!row) throw new Error('Fixture insert returned no row');
  ownedSnapshotTickers.push(row.ticker);
  return row.ticker;
}

async function cleanupOwnedSnapshots(): Promise<void> {
  if (ownedSnapshotTickers.length === 0) return;
  await db
    .delete(perpMarketSnapshots)
    .where(inArray(perpMarketSnapshots.ticker, ownedSnapshotTickers));
}

async function cleanupOwnedMarkets(): Promise<void> {
  if (ownedMarketIds.length === 0) return;
  await db.delete(markets).where(inArray(markets.id, ownedMarketIds));
}

async function fetchTickerPerps(): Promise<TickerPerp[]> {
  const response = await tickerGET(
    new NextRequest('http://localhost/api/ticker?streams=perps&limit=100')
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { perps?: TickerPerp[] };
  return body.perps ?? [];
}

async function fetchListedMarkets(): Promise<ListMarket[]> {
  const response = await perpsGET(
    new NextRequest('http://localhost/api/markets/perps?page=1&limit=100')
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { markets?: ListMarket[] };
  return body.markets ?? [];
}

function byTicker<T extends { ticker: string }>(rows: T[], ticker: string) {
  return rows.find((r) => r.ticker === ticker);
}

beforeAll(async () => {
  ({ GET: tickerGET } = await import(
    '../../../apps/web/src/app/api/ticker/route'
  ));
  ({ GET: perpsGET } = await import(
    '../../../apps/web/src/app/api/markets/perps/route'
  ));

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);

  // Price rose 100 -> 150 over the day; the last tick stored +50% against
  // the 100 reference, whose rotation is now due (updated 25h ago).
  await insertSnapshot({
    ticker: ROT,
    currentPrice: 150,
    price24hAgo: 100,
    price24hAgoUpdatedAt: dayAgo,
    changePercent24h: 50,
  });
  // Same stored state, but the reference rotated recently: no rotation due.
  await insertSnapshot({
    ticker: STEADY,
    currentPrice: 150,
    price24hAgo: 100,
    price24hAgoUpdatedAt: now,
    changePercent24h: 50,
  });
  // Brand-new market: no 24h reference has ever been set.
  await insertSnapshot({
    ticker: FRESH,
    currentPrice: 50,
    price24hAgo: null,
    price24hAgoUpdatedAt: null,
    changePercent24h: 0,
  });
  // Reference present, stored change 0%: a real 0%, not "no reference".
  await insertSnapshot({
    ticker: ZERO,
    currentPrice: 100,
    price24hAgo: 100,
    price24hAgoUpdatedAt: now,
    changePercent24h: 0,
  });
});

afterAll(async () => {
  await cleanupOwnedSnapshots();
});

describe('GET /api/ticker perps 24h change', () => {
  it('agrees with the markets list before any rotation', async () => {
    const tickerPerps = await fetchTickerPerps();
    const listed = await fetchListedMarkets();

    expect(byTicker(listed, ROT)?.changePercent24h).toBe(50);
    expect(byTicker(tickerPerps, ROT)?.changePercent24h).toBe(50);
    expect(byTicker(tickerPerps, STEADY)?.changePercent24h).toBe(50);
  });

  it('keeps showing the canonical change after the 24h reference rotates', async () => {
    // A funding-style stats write: no price change, no changePercent24h in
    // the update — but the adapter rotates price24hAgo to the current price
    // because the reference is more than 24h old.
    const adapter = new PerpDbAdapter();
    await adapter.updateMarketStats(ROT, {
      fundingRate: fundingRate(ROT),
    });

    const [row] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, ROT));
    // Rotation really happened, and the canonical stored change is intact.
    expect(row?.price24hAgo).toBe(150);
    expect(row?.changePercent24h).toBe(50);

    const tickerPerps = await fetchTickerPerps();
    const listed = await fetchListedMarkets();

    expect(byTicker(listed, ROT)?.changePercent24h).toBe(50);
    expect(byTicker(tickerPerps, ROT)?.changePercent24h).toBe(50);
    // The non-rotated market is unaffected throughout.
    expect(byTicker(tickerPerps, STEADY)?.changePercent24h).toBe(50);
  });

  it('shows null (no reference) for a market with no 24h reference price', async () => {
    const tickerPerps = await fetchTickerPerps();
    expect(byTicker(tickerPerps, FRESH)?.changePercent24h).toBeNull();
  });

  it('shows a stored 0% change (reference present) instead of null', async () => {
    const tickerPerps = await fetchTickerPerps();
    const listed = await fetchListedMarkets();

    // Control: the reference exists and the stored change is a real 0% —
    // both surfaces must show 0, not null.
    expect(byTicker(listed, ZERO)?.changePercent24h).toBe(0);
    expect(byTicker(tickerPerps, ZERO)?.changePercent24h).toBe(0);
  });

  // Runs last: it exercises the suite cleanup, which removes the fixtures,
  // so no later test may depend on them.
  it('a failed colliding setup leaves an unrelated snapshot untouched', async () => {
    // Stand-in for a pre-existing snapshot this suite never owned.
    const bystanderTicker = `F53BY${suffix}`;
    const collidingTicker = `F53COL${suffix}`;
    const now = new Date();
    await db.insert(perpMarketSnapshots).values(
      snapshotValues({
        ticker: bystanderTicker,
        currentPrice: 200,
        price24hAgo: 100,
        price24hAgoUpdatedAt: now,
        changePercent24h: 100,
      })
    );

    try {
      // Bulk setup colliding on the bystander's ticker (the primary key):
      // the whole INSERT fails, so neither row is created and neither
      // ticker becomes owned.
      // (try/catch rather than expect().rejects: a Drizzle query builder
      // is a thenable, not a Promise, and bun's .rejects rejects it.)
      let insertThrew = false;
      try {
        await db.insert(perpMarketSnapshots).values([
          snapshotValues({
            ticker: bystanderTicker,
            currentPrice: 200,
            price24hAgo: 100,
            price24hAgoUpdatedAt: now,
            changePercent24h: 100,
          }),
          snapshotValues({
            ticker: collidingTicker,
            currentPrice: 200,
            price24hAgo: 100,
            price24hAgoUpdatedAt: now,
            changePercent24h: 100,
          }),
        ]);
      } catch {
        insertThrew = true;
      }
      expect(insertThrew).toBe(true);

      // Run the exact cleanup afterAll uses: it must not touch the
      // bystander, and the failed colliding ticker must not exist either.
      await cleanupOwnedSnapshots();
      const [bystander] = await db
        .select({ ticker: perpMarketSnapshots.ticker })
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, bystanderTicker))
        .limit(1);
      expect(bystander?.ticker).toBe(bystanderTicker);
      const [colliding] = await db
        .select({ ticker: perpMarketSnapshots.ticker })
        .from(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, collidingTicker))
        .limit(1);
      expect(colliding).toBeUndefined();
    } finally {
      // The bystander is this test's own stand-in: remove it explicitly,
      // never through the suite's owned-tickers cleanup.
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, bystanderTicker));
    }
  });
});

describe('GET /api/ticker predictions yesPercent', () => {
  const marketId = `f53-pred-${suffix}`;

  beforeAll(async () => {
    const [row] = await db
      .insert(markets)
      .values({
        id: marketId,
        question: 'F53 ticker prediction fixture?',
        yesShares: '200',
        noShares: '800',
        liquidity: '1000',
        resolved: false,
        endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      })
      .returning({ id: markets.id });
    if (!row) throw new Error('Fixture insert returned no row');
    ownedMarketIds.push(row.id);
  });

  afterAll(async () => {
    await cleanupOwnedMarkets();
  });

  it('matches the canonical CPMM price for the same pool', async () => {
    const response = await tickerGET(
      new NextRequest(
        'http://localhost/api/ticker?streams=predictions&limit=100'
      )
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      predictions?: Array<{ id: string; yesPercent: number }>;
    };
    const item = (body.predictions ?? []).find((p) => p.id === marketId);
    // Canonical YES price for a 200/800 pool is noShares/total = 0.8.
    const canonical = Math.round(
      PredictionPricing.getCurrentPrice(200, 800, 'yes') * 100
    );
    expect(canonical).toBe(80);
    expect(item?.yesPercent).toBe(canonical);
  });
});

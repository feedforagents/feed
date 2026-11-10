/**
 * GET /api/feed/widgets/markets against a real database: the YES/NO prices
 * the sidebar widget shows for a market must be the market's CPMM prices —
 * the same values the market detail route reports as yesProbability /
 * noProbability.
 *
 * CPMM price (PRD §9.2 [D-14], "CPMM price = cost per share") is defined by
 * PredictionPricing.getCurrentPrice: the YES price is the NO side's share of
 * the pool (noShares / total), because the pool's YES shares are what a buyer
 * takes out — a scarcer YES pool means a pricier YES. Every other surface
 * uses that definition: the list and detail routes, the recorded price
 * history (calc.newYesPrice), the admin markets route (which states the
 * formula in a comment), and the A2A executor.
 *
 * The widget route instead divided the YES side's own shares by the total,
 * which is 1 − price: a market seeded at an 80% YES probability was shown in
 * the sidebar as "Yes 20% / No 80%".
 *
 * The 24h change is read from the canonical recorded price history
 * (PredictionPriceHistory): the latest snapshot at or before 24h ago is the
 * baseline. A market with no snapshot that old reports no change. The past
 * pool is never reconstructed from positions — held shares are not the
 * inverse pool delta. A real YES buy of 1000 on a 5000/5000 pool leaves
 * 4166.6667/6000 and 1833.3333 held shares; subtracting the held shares
 * invents a past pool of 2333.3333/6000 (price 0.72) and reports −18.03%
 * for a price that actually rose 0.5 → 0.590164 (+18.03%).
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion with an explicit initial
 * probability) and real trades through PredictionMarketService. The only stub
 * is the `server-only` marker package and, for the trades, the wallet port
 * (the market-engine integration precedent); pool state, positions, price
 * history, and both routes run for real.
 *
 * The widget's application cache is five minutes (DEFAULT_TTLS.WIDGET);
 * Next revalidate is 60s — neither is the cause of the wrong values.
 *
 * Ownership: every row this file creates is recorded from its RETURNING
 * clause, and teardown deletes only those owned rows — including the
 * PredictionPriceHistory rows the real trades write, which have no
 * cascading FK — then verifies zero rows remain. A setup collision (a
 * second insert under an owned id) must reject instead of silently
 * reusing or overwriting the fixture.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { CACHE_KEYS, invalidateCache, isRedisAvailable } from '@feed/api';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  closeDatabase,
  db,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  questions,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { z } from 'zod';

type WidgetMarket = {
  id: string;
  yesPrice: number;
  noPrice: number;
  changePercent24h?: number;
};
type WidgetResponse = { success: boolean; markets: WidgetMarket[] };
type DetailResponse = {
  success: boolean;
  market: { yesProbability: number; noProbability: number };
};

let widgetGET: typeof import('../../../apps/web/src/app/api/feed/widgets/markets/route').GET;
let detailGET: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const userId = await generateSnowflakeId();
const skewedId = `f43-wmp-skewed-${suffix}`;
const historyLoadId = `f43-wmp-history-load-${suffix}`;
const evenId = `f43-wmp-even-${suffix}`;
const tradedBuyId = `f43-wmp-traded-buy-${suffix}`;
const tradedSellId = `f43-wmp-traded-sell-${suffix}`;
let questionNumber = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);

// Rows this file owns, recorded from each insert's RETURNING clause.
// Teardown deletes only these — never the preallocated ids as such.
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
let ownedUserId: string | null = null;

async function fetchWidget(token?: string) {
  const response = await widgetGET(
    new NextRequest('http://localhost/api/feed/widgets/markets', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as WidgetResponse;
}

async function fetchDetail(marketId: string) {
  const response = await detailGET(
    new NextRequest(`http://localhost/api/markets/predictions/${marketId}`),
    { params: Promise.resolve({ id: marketId }) }
  );
  return (await response.json()) as DetailResponse;
}

async function createMarket(
  id: string,
  initialYesProbability: number
): Promise<void> {
  expect(
    await db.select({ id: markets.id }).from(markets).where(eq(markets.id, id))
  ).toEqual([]);
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: questionNumber++,
      text: `Widget price fixture ${id}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 7 * 86400000),
      status: 'active',
      updatedAt: new Date(),
    })
    .returning({
      id: questions.id,
      text: questions.text,
      resolutionDate: questions.resolutionDate,
    });
  if (!question) throw new Error(`question insert failed for ${id}`);
  ownedQuestionIds.push(question.id);
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    10000,
    { initialYesProbability }
  );
  ownedMarketIds.push(market.id);
}

/**
 * Seed the recorded price 24h+ ago for a market: a PredictionPriceHistory
 * row just outside the window, so the widget's baseline is a real recorded
 * price rather than a reconstructed pool. Market creation writes no
 * snapshot, so the baseline is seeded explicitly.
 */
async function seedBaselineHistory(
  label: string,
  marketId: string,
  yesPrice: number
): Promise<void> {
  const [row] = await db
    .insert(predictionPriceHistories)
    .values({
      id: `f43-wmp-hist-${label}-${suffix}`,
      marketId,
      yesPrice,
      noPrice: 1 - yesPrice,
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      eventType: 'trade',
      source: 'system',
      createdAt: new Date(Date.now() - 25 * 3600 * 1000),
    })
    .returning({ id: predictionPriceHistories.id });
  if (!row) throw new Error(`history seed failed for ${marketId}`);
}

beforeAll(async () => {
  ({ GET: widgetGET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/markets/route'
  ));
  ({ GET: detailGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/route'
  ));

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      username: `f43wmp-${suffix}`,
      stewardId: `f43-${userId}`,
      displayName: 'Widget Price Fixture User',
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert failed');
  ownedUserId = user.id;

  // Skewed pool: seeded at an 80% YES probability (yes 2000 / no 8000),
  // with a recorded 0.5 price just outside the 24h window.
  await createMarket(skewedId, 0.8);
  await seedBaselineHistory('skewed', skewedId, 0.5);
  // Even pool: 50/50 — both price definitions agree, guard case. No
  // history is seeded, so no 24h change may be reported for it.
  await createMarket(evenId, 0.5);
  // Traded pools: start even, with a recorded 0.5 price just outside
  // the 24h window; then real trades move the price up.
  await createMarket(tradedBuyId, 0.5);
  await seedBaselineHistory('buy', tradedBuyId, 0.5);
  await createMarket(tradedSellId, 0.5);
  await seedBaselineHistory('sell', tradedSellId, 0.5);

  await createMarket(historyLoadId, 0.8);
  // Thousands of real persisted snapshots, plus a same-timestamp tie whose
  // lexicographically greatest ID has a different baseline price.
  const oldTime = new Date(Date.now() - 30 * 86400000);
  for (let start = 0; start < 4000; start += 500) {
    await db.insert(predictionPriceHistories).values(
      Array.from({ length: 500 }, (_, i) => ({
        id: `f43-old-${suffix}-${start + i}`,
        marketId: historyLoadId,
        yesPrice: 0.1,
        noPrice: 0.9,
        yesShares: '5000',
        noShares: '5000',
        liquidity: '10000',
        eventType: 'trade',
        source: 'system',
        createdAt: oldTime,
      }))
    );
  }
  const tieTime = new Date(Date.now() - 26 * 3600_000);
  await db.insert(predictionPriceHistories).values(
    ['a', 'z'].map((label) => ({
      id: `f43-tie-${suffix}-${label}`,
      marketId: historyLoadId,
      yesPrice: label === 'z' ? 0.4 : 0.2,
      noPrice: label === 'z' ? 0.6 : 0.8,
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      eventType: 'trade',
      source: 'system',
      createdAt: tieTime,
    }))
  );

  const service = new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 1_000_000 }),
    },
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.7,
      referrerShare: 0.3,
      minFeeAmount: 0.01,
    },
  });
  await service.buy({
    marketId: tradedBuyId,
    userId,
    amount: 1000,
    side: 'yes',
  });
  const sellBuy = await service.buy({
    marketId: tradedSellId,
    userId,
    amount: 1000,
    side: 'yes',
  });
  await service.sell({
    marketId: tradedSellId,
    userId,
    shares: 500,
    positionId: sellBuy.positionId,
  });
});

afterAll(async () => {
  expect(isRedisAvailable()).toBe(false);
  await invalidateCache('markets-widget-v3', { namespace: CACHE_KEYS.WIDGET });
  // Delete only owned rows, in dependency order. The real trades also
  // wrote PredictionPriceHistory rows (no cascading FK), so history for
  // owned markets goes first. Any failure throws — cleanup is never
  // swallowed — and the zero-check below proves nothing is left behind.
  await db
    .delete(predictionPriceHistories)
    .where(inArray(predictionPriceHistories.marketId, ownedMarketIds));
  await db.delete(positions).where(inArray(positions.marketId, ownedMarketIds));
  const deletedMarkets = await db
    .delete(markets)
    .where(inArray(markets.id, ownedMarketIds))
    .returning({ id: markets.id });

  const deletedQuestions = await db
    .delete(questions)
    .where(inArray(questions.id, ownedQuestionIds))
    .returning({ id: questions.id });

  if (ownedUserId) {
    const deletedUsers = await db
      .delete(users)
      .where(eq(users.id, ownedUserId))
      .returning({ id: users.id });
    expect(deletedUsers.length).toBe(1);
  }

  expect(deletedMarkets.length).toBe(ownedMarketIds.length);
  expect(deletedQuestions.length).toBe(ownedQuestionIds.length);

  const leftoverHistory = await db
    .select({ id: predictionPriceHistories.id })
    .from(predictionPriceHistories)
    .where(inArray(predictionPriceHistories.marketId, ownedMarketIds));
  expect(leftoverHistory).toHaveLength(0);
  const leftoverPositions = await db
    .select({ id: positions.id })
    .from(positions)
    .where(inArray(positions.marketId, ownedMarketIds));
  expect(leftoverPositions).toHaveLength(0);
  const leftoverMarkets = await db
    .select({ id: markets.id })
    .from(markets)
    .where(inArray(markets.id, ownedMarketIds));
  expect(leftoverMarkets).toHaveLength(0);
  const leftoverQuestions = await db
    .select({ id: questions.id })
    .from(questions)
    .where(inArray(questions.id, ownedQuestionIds));
  expect(leftoverQuestions).toHaveLength(0);
  if (ownedUserId) {
    const leftoverUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, ownedUserId));
    expect(leftoverUsers).toHaveLength(0);
  }
  await closeDatabase();
});

describe('markets widget prices', () => {
  it('shows the CPMM price for a skewed market, matching the detail route', async () => {
    const [widget, detail] = await Promise.all([
      fetchWidget(),
      fetchDetail(skewedId),
    ]);
    const row = widget.markets.find((m) => m.id === skewedId);
    expect(row).toBeDefined();
    expect(detail.market.yesProbability).toBeCloseTo(0.8, 10);
    expect(row?.yesPrice).toBeCloseTo(detail.market.yesProbability, 10);
    expect(row?.noPrice).toBeCloseTo(detail.market.noProbability, 10);
    expect(row?.yesPrice).toBeCloseTo(0.8, 10);
    expect(row?.noPrice).toBeCloseTo(0.2, 10);
  });

  it('reports the 24h change from the recorded price history', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === skewedId);
    expect(row?.changePercent24h).toBeDefined();
    // Recorded 0.5 -> current 0.8.
    expect(row?.changePercent24h ?? 0).toBeCloseTo(60, 6);
  });

  it('keeps an even market at 50/50 and reports no change without history (guard)', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === evenId);
    expect(row).toBeDefined();
    expect(row?.yesPrice).toBeCloseTo(0.5, 10);
    expect(row?.noPrice).toBeCloseTo(0.5, 10);
    expect(row?.changePercent24h).toBeUndefined();
  });

  it('tracks a real buy: widget change matches the detail price move', async () => {
    const [widget, detail] = await Promise.all([
      fetchWidget(),
      fetchDetail(tradedBuyId),
    ]);
    const row = widget.markets.find((m) => m.id === tradedBuyId);
    expect(row).toBeDefined();
    expect(detail.market.yesProbability).toBeGreaterThan(0.5);
    expect(row?.yesPrice).toBeCloseTo(detail.market.yesProbability, 10);
    expect(row?.yesPrice ?? 0).toBeGreaterThan(0.5);
    // Recorded 0.5 baseline -> current detail price: a real YES buy
    // must read as a rise, not a fall.
    expect(row?.changePercent24h).toBeDefined();
    const expected = ((detail.market.yesProbability - 0.5) / 0.5) * 100;
    expect(row?.changePercent24h ?? 0).toBeCloseTo(expected, 6);
    expect(row?.changePercent24h ?? 0).toBeGreaterThan(0);
  });

  it('tracks a real buy then sell: change stays positive and matches the detail price', async () => {
    const [widget, detail] = await Promise.all([
      fetchWidget(),
      fetchDetail(tradedSellId),
    ]);
    const row = widget.markets.find((m) => m.id === tradedSellId);
    expect(row).toBeDefined();
    expect(detail.market.yesProbability).toBeGreaterThan(0.5);
    expect(row?.yesPrice).toBeCloseTo(detail.market.yesProbability, 10);
    const expected = ((detail.market.yesProbability - 0.5) / 0.5) * 100;
    expect(row?.changePercent24h).toBeDefined();
    expect(row?.changePercent24h ?? 0).toBeCloseTo(expected, 6);
    expect(row?.changePercent24h ?? 0).toBeGreaterThan(0);
    // The partial sell pulled the price back from the buy-only level.
    const buyOnly = widget.markets.find((m) => m.id === tradedBuyId);
    expect(buyOnly?.changePercent24h).toBeDefined();
    expect(row?.changePercent24h ?? 0).toBeLessThan(
      buyOnly?.changePercent24h ?? 0
    );
  });

  it('selects one deterministic baseline for large/tied history on public cold/warm and authenticated reads', async () => {
    expect(isRedisAvailable()).toBe(false);
    await invalidateCache('markets-widget-v3', {
      namespace: CACHE_KEYS.WIDGET,
    });
    const token = await new SignJWT({ userId: `f43-${userId}` })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(
        new TextEncoder().encode(
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
        )
      );
    for (const credential of [undefined, undefined, token]) {
      const response = await fetchWidget(credential);
      const row = response.markets.find((m) => m.id === historyLoadId);
      expect(row?.yesPrice).toBeCloseTo(0.8, 10);
      expect(row?.changePercent24h).toBeCloseTo(100, 6);
    }
    const oldPlanRows =
      await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM "PredictionPriceHistory"
      WHERE "marketId" = ${historyLoadId} AND "createdAt" <= ${new Date(Date.now() - 86400000).toISOString()}::timestamp
      ORDER BY "createdAt" DESC`);
    const planRows =
      await db.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT DISTINCT ON ("marketId") "marketId", "yesPrice" FROM "PredictionPriceHistory"
      WHERE "marketId" = ${historyLoadId} AND "createdAt" <= ${new Date(Date.now() - 86400000).toISOString()}::timestamp
      ORDER BY "marketId", "createdAt" DESC, "id" DESC`);
    const planSchema = z.array(
      z.object({
        'QUERY PLAN': z.array(
          z
            .object({
              Plan: z.object({ 'Actual Rows': z.number() }).passthrough(),
              'Execution Time': z.number(),
            })
            .passthrough()
        ),
      })
    );
    const plan = planSchema.parse(planRows);
    const oldPlan = planSchema.parse(oldPlanRows);
    expect(oldPlan[0]?.['QUERY PLAN'][0]?.Plan['Actual Rows']).toBe(4002);
    console.log(
      'WIDGET_OLD_BASELINE_PLAN',
      JSON.stringify(oldPlan[0]?.['QUERY PLAN'][0])
    );
    const result = plan[0]?.['QUERY PLAN'][0];
    expect(result?.Plan['Actual Rows']).toBe(1);
    console.log('WIDGET_BASELINE_PLAN', JSON.stringify(result));
  });

  it('setup collision: a second insert under an owned id rejects', async () => {
    await expect(
      (async () => {
        await db.insert(questions).values({
          id: skewedId,
          questionNumber: questionNumber++,
          text: 'Widget price fixture collision',
          scenarioId: 1,
          outcome: false,
          rank: 1,
          resolutionDate: new Date(Date.now() + 7 * 86400000),
          status: 'active',
          updatedAt: new Date(),
        });
      })()
    ).rejects.toThrow();
    // The original fixture row is untouched by the rejected insert.
    const rows = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, skewedId));
    expect(rows).toHaveLength(1);
  });
});

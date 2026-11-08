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
 * the sidebar as "Yes 20% / No 80%", and its 24h change carried the opposite
 * sign (a rise from 50% to 80% was reported as −60% instead of +60%), so the
 * panel's Top Movers section promoted fallers as if the price had moved the
 * other way. The amounts are not stale — the cache is 60s — they are the
 * complement of the real price on every read.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion with an explicit initial
 * probability) and, for the third case, a real trade through
 * PredictionMarketService. The only stub is the `server-only` marker package
 * and, for the trade, the wallet port (the market-engine integration
 * precedent); pool state, positions, and both routes run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  db,
  eq,
  inArray,
  markets,
  positions,
  questions,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';

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
const userId = `f43-wmp-user-${suffix}`;
const skewedId = `f43-wmp-skewed-${suffix}`;
const evenId = `f43-wmp-even-${suffix}`;
const tradedId = `f43-wmp-traded-${suffix}`;
const positionId = `f43-wmp-pos-${suffix}`;
const questionIds = [skewedId, evenId, tradedId];
let questionNumber = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);

async function fetchWidget() {
  const response = await widgetGET(
    new NextRequest('http://localhost/api/feed/widgets/markets')
  );
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
    .returning();
  if (!question) throw new Error(`question insert failed for ${id}`);
  await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    10000,
    { initialYesProbability }
  );
}

beforeAll(async () => {
  ({ GET: widgetGET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/markets/route'
  ));
  ({ GET: detailGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/route'
  ));

  await db.insert(users).values({
    id: userId,
    username: `f43wmp-${suffix}`,
    displayName: 'Widget Price Fixture User',
    updatedAt: new Date(),
  });

  // Skewed pool: seeded at an 80% YES probability (yes 2000 / no 8000).
  await createMarket(skewedId, 0.8);
  // Even pool: 50/50 — both price definitions agree, guard case.
  await createMarket(evenId, 0.5);
  // Traded pool: starts even, then a real YES buy moves the price up.
  await createMarket(tradedId, 0.5);

  // One NO position inside the 24h window for the skewed market. The
  // widget's lookback subtracts it, estimating the past pool at
  // yes 2000 / no 2000, so the canonical change is 0.5 -> 0.8 = +60%
  // (the flipped definition reports 0.5 -> 0.2 = -60%).
  await db.insert(positions).values({
    id: positionId,
    userId,
    marketId: skewedId,
    side: false,
    shares: '6000',
    avgPrice: '0.500000',
    amount: '3000.00',
    status: 'active',
    updatedAt: new Date(),
  });

  const service = new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => 1_000_000,
    },
    fees: {
      tradingFeeRate: 0.001,
      platformShare: 0.7,
      referrerShare: 0.3,
      minFeeAmount: 0.01,
    },
  });
  await service.buy({
    marketId: tradedId,
    userId,
    amount: 1000,
    side: 'yes',
  });
});

afterAll(async () => {
  await db
    .delete(positions)
    .where(inArray(positions.marketId, questionIds))
    .catch(() => {});
  await db
    .delete(markets)
    .where(inArray(markets.id, questionIds))
    .catch(() => {});
  await db
    .delete(questions)
    .where(inArray(questions.id, questionIds))
    .catch(() => {});
  await db
    .delete(users)
    .where(eq(users.id, userId))
    .catch(() => {});
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

  it('reports the 24h change with the canonical sign', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === skewedId);
    expect(row?.changePercent24h).toBeDefined();
    expect(row?.changePercent24h ?? 0).toBeCloseTo(60, 6);
  });

  it('keeps an even market at 50/50 (guard)', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === evenId);
    expect(row).toBeDefined();
    expect(row?.yesPrice).toBeCloseTo(0.5, 10);
    expect(row?.noPrice).toBeCloseTo(0.5, 10);
  });

  it('tracks a real trade: widget price rises with the detail price', async () => {
    const [widget, detail] = await Promise.all([
      fetchWidget(),
      fetchDetail(tradedId),
    ]);
    const row = widget.markets.find((m) => m.id === tradedId);
    expect(row).toBeDefined();
    expect(detail.market.yesProbability).toBeGreaterThan(0.5);
    expect(row?.yesPrice).toBeCloseTo(detail.market.yesProbability, 10);
    expect(row?.yesPrice ?? 0).toBeGreaterThan(0.5);
  });
});

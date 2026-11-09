/**
 * GET /api/feed/widgets/markets against a real database: the "Vol" number
 * the sidebar widget prints under a market (with the Feed Points currency
 * symbol) must be the market's traded volume — the same definition the
 * market dynamics route reports as totalVolume: the sum over the market's
 * positions of shares × avgPrice.
 *
 * The widget route instead reports the pool's current share balances
 * (yesShares + noShares). A freshly seeded market with zero trades is
 * shown as "Vol 10,000" (its seed liquidity), and the figure moves with
 * pool balances rather than with trading activity, so it disagrees with
 * the traded volume on every read. The widget's popularity sort uses the
 * same value at 70% weight.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and one real trade
 * through PredictionMarketService (the widget-price integration
 * precedent). The expected volume is computed from the positions ledger
 * exactly the way the dynamics route computes totalVolume.
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
  volume: number;
};
type WidgetResponse = { success: boolean; markets: WidgetMarket[] };

let widgetGET: typeof import('../../../apps/web/src/app/api/feed/widgets/markets/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const userId = `f112-wmv-user-${suffix}`;
const idleId = `f112-wmv-idle-${suffix}`;
const tradedId = `f112-wmv-traded-${suffix}`;
const questionIds = [idleId, tradedId];
let questionNumber = 1_800_000_000 + Math.floor(Math.random() * 100_000_000);

async function fetchWidget() {
  const response = await widgetGET(
    new NextRequest('http://localhost/api/feed/widgets/markets')
  );
  return (await response.json()) as WidgetResponse;
}

/** Traded volume exactly as the dynamics route defines totalVolume. */
async function ledgerVolume(marketId: string): Promise<number> {
  const rows = await db
    .select({ shares: positions.shares, avgPrice: positions.avgPrice })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  return rows.reduce(
    (sum, p) => sum + Number(p.shares) * Number(p.avgPrice),
    0
  );
}

async function createMarket(id: string): Promise<void> {
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: questionNumber++,
      text: `Widget volume fixture ${id}`,
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
    { initialYesProbability: 0.5 }
  );
}

beforeAll(async () => {
  ({ GET: widgetGET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/markets/route'
  ));

  await db.insert(users).values({
    id: userId,
    username: `f112wmv-${suffix}`,
    displayName: 'Widget Volume Fixture User',
    updatedAt: new Date(),
  });

  // Idle market: seeded with liquidity, never traded.
  await createMarket(idleId);
  // Traded market: seeded the same way, then one real YES buy.
  await createMarket(tradedId);

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

describe('markets widget volume', () => {
  it('shows zero volume for a seeded market with no trades', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === idleId);
    expect(row).toBeDefined();
    expect(await ledgerVolume(idleId)).toBe(0);
    expect(row?.volume).toBe(0);
  });

  it('shows the traded volume from the positions ledger after a real trade', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === tradedId);
    expect(row).toBeDefined();
    const expected = await ledgerVolume(tradedId);
    expect(expected).toBeGreaterThan(0);
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
  });
});

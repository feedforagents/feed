/**
 * GET /api/markets/predictions against a real database: the markets list
 * page (/markets) prints a "Vol" figure for each prediction market and
 * sorts by it (default sort, descending) in both list views — the desktop
 * dashboard table and the terminal's unified rows.
 *
 * The traded volume a reader expects is the definition the market dynamics
 * route reports as totalVolume: the sum over the market's positions of
 * shares × avgPrice. The list response carries no volume at all, so both
 * list views substitute the pool's current share balances
 * (yesShares + noShares): a freshly seeded market with zero trades reads
 * "Vol 20,000" (its seed liquidity) and outranks a market with real trades
 * in the default volume sort.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and one real trade
 * through PredictionMarketService (the widget-volume integration
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

type ListQuestion = {
  id: string;
  yesShares: number;
  noShares: number;
  volume?: number;
};
type ListResponse = { success: boolean; questions: ListQuestion[] };

let listGET: typeof import('../../../apps/web/src/app/api/markets/predictions/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const userId = `f138-mlv-user-${suffix}`;
const idleId = `f138-mlv-idle-${suffix}`;
const tradedId = `f138-mlv-traded-${suffix}`;
const questionIds = [idleId, tradedId];
let questionNumber = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);

async function fetchList() {
  const response = await listGET(
    new NextRequest('http://localhost/api/markets/predictions')
  );
  return (await response.json()) as ListResponse;
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

async function createMarket(id: string, liquidity: number): Promise<void> {
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: questionNumber++,
      text: `Market list volume fixture ${id}`,
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
    liquidity,
    { initialYesProbability: 0.5 }
  );
}

beforeAll(async () => {
  ({ GET: listGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/route'
  ));

  await db.insert(users).values({
    id: userId,
    username: `f138mlv-${suffix}`,
    displayName: 'Market List Volume Fixture User',
    updatedAt: new Date(),
  });

  // Idle market: seeded with deep liquidity, never traded. Its pool
  // balance (20,000) is larger than the traded market's, so the pool-based
  // "volume" ranks it first even though nothing ever traded there.
  await createMarket(idleId, 20000);
  // Traded market: shallower seed than the idle market, then one real
  // YES buy (sized to stay inside the per-trade odds-move cap).
  await createMarket(tradedId, 4000);

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
    amount: 500,
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

describe('markets list volume', () => {
  it('reports zero volume for a seeded market with no trades', async () => {
    const list = await fetchList();
    const row = list.questions.find((q) => q.id === idleId);
    expect(row).toBeDefined();
    expect(await ledgerVolume(idleId)).toBe(0);
    expect(row?.volume).toBe(0);
  });

  it('reports the traded volume from the positions ledger after a real trade', async () => {
    const list = await fetchList();
    const row = list.questions.find((q) => q.id === tradedId);
    expect(row).toBeDefined();
    const expected = await ledgerVolume(tradedId);
    expect(expected).toBeGreaterThan(0);
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
  });

  it('ranks the traded market above the idle one by volume, opposite to pool balances', async () => {
    const list = await fetchList();
    const idle = list.questions.find((q) => q.id === idleId);
    const traded = list.questions.find((q) => q.id === tradedId);
    expect(idle).toBeDefined();
    expect(traded).toBeDefined();
    // Pool balances rank the never-traded market first — the base defect.
    const idlePool = Number(idle?.yesShares ?? 0) + Number(idle?.noShares ?? 0);
    const tradedPool =
      Number(traded?.yesShares ?? 0) + Number(traded?.noShares ?? 0);
    expect(idlePool).toBeGreaterThan(tradedPool);
    // Traded volume must rank the actually-traded market first.
    expect(traded?.volume ?? 0).toBeGreaterThan(idle?.volume ?? 0);
  });
});

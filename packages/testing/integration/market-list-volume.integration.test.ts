/**
 * GET /api/markets/predictions against a real database: the markets list
 * page (/markets) prints a "Vol" figure for each prediction market and
 * sorts by it (default sort, descending) in both list views — the desktop
 * dashboard table and the terminal's unified rows.
 *
 * Traded volume is the all-time sum of shares × trade price over the
 * market's append-only trade ledger (PredictionTrade): every buy and every
 * sell appends one row. A sell adds volume exactly like a buy — selling
 * out of a position must not erase the volume the trades already created.
 * The pool's current share balances (yesShares + noShares) are not volume:
 * a freshly seeded market with zero trades reads "Vol 20,000" (its seed
 * liquidity) and outranks a market with real trades in the default sort.
 * Neither is the current positions total: a buy followed by a full sell
 * leaves zero position shares behind, so positions cannot reconstruct
 * volume.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and real trades through
 * PredictionMarketService (the widget-volume integration precedent). The
 * expected volume is read from the trade ledger itself.
 *
 * Ownership: fixture ids are registered only from successful INSERT …
 * RETURNING results, and teardown deletes only registered rows — a
 * colliding setup insert registers nothing and can never delete a
 * pre-existing row. The list fetch uses ?limit=100 (the paginated path)
 * so every observation bypasses the 12 s list cache and reads fresh data.
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
  predictionPriceHistories,
  predictionTrades,
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
const soldId = `f138-mlv-sold-${suffix}`;
// Ownership is registered only from successful INSERT … RETURNING results.
const ownedUserIds: string[] = [];
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
let questionNumber = 1_900_000_000 + Math.floor(Math.random() * 100_000_000);
let service: PredictionMarketService;

async function fetchList() {
  const response = await listGET(
    new NextRequest('http://localhost/api/markets/predictions?limit=100')
  );
  return (await response.json()) as ListResponse;
}

/** Traded volume exactly as the route defines it: all-time Σ amount over the trade ledger. */
async function ledgerVolume(marketId: string): Promise<number> {
  const rows = await db
    .select({ amount: predictionTrades.amount })
    .from(predictionTrades)
    .where(eq(predictionTrades.marketId, marketId));
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

async function positionShares(marketId: string): Promise<number> {
  const rows = await db
    .select({ shares: positions.shares })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  return rows.reduce((sum, p) => sum + Number(p.shares), 0);
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
  ownedQuestionIds.push(question.id);
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    liquidity,
    { initialYesProbability: 0.5 }
  );
  ownedMarketIds.push(market.id);
}

beforeAll(async () => {
  ({ GET: listGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/route'
  ));

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      username: `f138mlv-${suffix}`,
      displayName: 'Market List Volume Fixture User',
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error(`user insert failed for ${userId}`);
  ownedUserIds.push(user.id);

  // Idle market: seeded with deep liquidity, never traded. Its pool
  // balance (20,000) is larger than the traded market's, so the pool-based
  // "volume" ranks it first even though nothing ever traded there.
  await createMarket(idleId, 20000);
  // Traded market: shallower seed than the idle market, then one real
  // YES buy (sized to stay inside the per-trade odds-move cap).
  await createMarket(tradedId, 4000);
  // Sold market: seeded only; the sell cases buy and sell on it themselves.
  await createMarket(soldId, 4000);

  service = new PredictionMarketService({
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
    marketId: tradedId,
    userId,
    amount: 500,
    side: 'yes',
  });
});

afterAll(async () => {
  // Delete owned derived rows first, then the owned rows themselves.
  // No catch-all: a failed cleanup must fail the run, not hide a leak.
  await db
    .delete(predictionTrades)
    .where(inArray(predictionTrades.marketId, ownedMarketIds));
  await db
    .delete(predictionPriceHistories)
    .where(inArray(predictionPriceHistories.marketId, ownedMarketIds));
  await db.delete(positions).where(inArray(positions.marketId, ownedMarketIds));
  await db.delete(markets).where(inArray(markets.id, ownedMarketIds));
  await db.delete(questions).where(inArray(questions.id, ownedQuestionIds));
  await db.delete(users).where(inArray(users.id, ownedUserIds));

  // Residue readback: nothing owned may survive the run.
  const [
    tradeRows,
    historyRows,
    positionRows,
    marketRows,
    questionRows,
    userRows,
  ] = await Promise.all([
    db
      .select()
      .from(predictionTrades)
      .where(inArray(predictionTrades.marketId, ownedMarketIds)),
    db
      .select()
      .from(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, ownedMarketIds)),
    db
      .select()
      .from(positions)
      .where(inArray(positions.marketId, ownedMarketIds)),
    db.select().from(markets).where(inArray(markets.id, ownedMarketIds)),
    db.select().from(questions).where(inArray(questions.id, ownedQuestionIds)),
    db.select().from(users).where(inArray(users.id, ownedUserIds)),
  ]);
  expect(tradeRows).toHaveLength(0);
  expect(historyRows).toHaveLength(0);
  expect(positionRows).toHaveLength(0);
  expect(marketRows).toHaveLength(0);
  expect(questionRows).toHaveLength(0);
  expect(userRows).toHaveLength(0);
});

describe('markets list volume', () => {
  it('reports zero volume for a seeded market with no trades', async () => {
    const list = await fetchList();
    const row = list.questions.find((q) => q.id === idleId);
    expect(row).toBeDefined();
    expect(await ledgerVolume(idleId)).toBe(0);
    expect(row?.volume).toBe(0);
  });

  it('reports the traded volume from the trade ledger after a real trade', async () => {
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

  it('keeps volume after a partial sell', async () => {
    await service.buy({
      marketId: soldId,
      userId,
      amount: 500,
      side: 'yes',
    });
    const afterBuy = await ledgerVolume(soldId);
    expect(afterBuy).toBeGreaterThan(0);
    const bought = await positionShares(soldId);
    expect(bought).toBeGreaterThan(0);

    const position = await new PredictionDbAdapter().getPosition(
      userId,
      soldId,
      'yes'
    );
    expect(position).not.toBeNull();
    await service.sell({
      marketId: soldId,
      userId,
      shares: bought / 2,
      positionId: position?.id,
    });

    // A sell ADDS volume: the ledger holds the buy plus the sell.
    const afterSell = await ledgerVolume(soldId);
    expect(afterSell).toBeGreaterThan(afterBuy);
    const remaining = await positionShares(soldId);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(bought);

    const list = await fetchList();
    const row = list.questions.find((q) => q.id === soldId);
    expect(row?.volume ?? -1).toBeCloseTo(afterSell, 6);
  });

  it('keeps volume after a full close', async () => {
    const beforeClose = await ledgerVolume(soldId);
    expect(beforeClose).toBeGreaterThan(0);
    const remaining = await positionShares(soldId);
    expect(remaining).toBeGreaterThan(0);

    const position = await new PredictionDbAdapter().getPosition(
      userId,
      soldId,
      'yes'
    );
    expect(position).not.toBeNull();
    await service.sell({
      marketId: soldId,
      userId,
      shares: remaining,
      positionId: position?.id,
    });

    // The closing sell adds volume too, while the position is now empty.
    // The old positions-based definition reported zero here.
    expect(await positionShares(soldId)).toBe(0);
    const afterClose = await ledgerVolume(soldId);
    expect(afterClose).toBeGreaterThan(beforeClose);
    const list = await fetchList();
    const row = list.questions.find((q) => q.id === soldId);
    expect(row?.volume ?? -1).toBeCloseTo(afterClose, 6);
    expect(row?.volume ?? 0).toBeGreaterThan(0);
  });
});

describe('fixture ownership', () => {
  it('never deletes pre-existing rows when a setup insert collides', async () => {
    const foreignUserId = `f138-mlv-foreign-user-${suffix}`;
    const foreignQuestionId = `f138-mlv-foreign-q-${suffix}`;
    const ownedUserId = `f138-mlv-owned-user-${suffix}`;

    // Rows the fixture does not own, created before the setup runs.
    const [foreignUser] = await db
      .insert(users)
      .values({
        id: foreignUserId,
        username: `f138foreign-${suffix}`,
        displayName: 'Foreign Fixture User',
        updatedAt: new Date(),
      })
      .returning();
    expect(foreignUser?.id).toBe(foreignUserId);
    const [foreignQuestion] = await db
      .insert(questions)
      .values({
        id: foreignQuestionId,
        questionNumber: questionNumber++,
        text: `Foreign fixture question ${suffix}`,
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 7 * 86400000),
        status: 'active',
        updatedAt: new Date(),
      })
      .returning();
    expect(foreignQuestion?.id).toBe(foreignQuestionId);

    try {
      // Partial setup: one owned row succeeds and registers…
      const [owned] = await db
        .insert(users)
        .values({
          id: ownedUserId,
          username: `f138owned-${suffix}`,
          displayName: 'Owned Fixture User',
          updatedAt: new Date(),
        })
        .returning();
      const ownedIds = owned ? [owned.id] : [];

      // …while a second insert colliding with the foreign row fails
      // and registers nothing.
      let colliding: Array<{ id: string }> = [];
      try {
        colliding = await db
          .insert(users)
          .values({
            id: foreignUserId,
            username: `f138collision-${suffix}`,
            displayName: 'Collision',
            updatedAt: new Date(),
          })
          .returning();
      } catch {
        colliding = [];
      }
      expect(colliding).toHaveLength(0);

      // The same cleanup the suite teardown runs, scoped to owned ids only.
      await db.delete(users).where(inArray(users.id, ownedIds));

      const [foreignAfter] = await db
        .select()
        .from(users)
        .where(eq(users.id, foreignUserId));
      expect(foreignAfter?.id).toBe(foreignUserId);
      const [foreignQuestionAfter] = await db
        .select()
        .from(questions)
        .where(eq(questions.id, foreignQuestionId));
      expect(foreignQuestionAfter?.id).toBe(foreignQuestionId);
      const [ownedAfter] = await db
        .select()
        .from(users)
        .where(eq(users.id, ownedUserId));
      expect(ownedAfter).toBeUndefined();
    } finally {
      // Leave no trace of the foreign rows either.
      await db.delete(users).where(eq(users.id, foreignUserId));
      await db.delete(questions).where(eq(questions.id, foreignQuestionId));
    }
  });
});

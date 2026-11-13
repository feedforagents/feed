/**
 * GET /api/questions/[id]/dynamics against a real database: the route
 * reports the market's totalVolume (sum over the market's positions of
 * shares × avgPrice) and totalPositions as the market's totals — the same
 * definition the admin trading stats compute with an uncapped SQL SUM
 * over every position row.
 *
 * The route loads only the most recent 1,000 position rows and computes
 * both totals from that sample, so on a market with more than 1,000
 * positions the reported totalVolume understates the positions ledger
 * and totalPositions reads 1,000 instead of the real count.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and real trades through
 * PredictionMarketService — 1,005 distinct buyers on the busy market, so
 * the position rows are exactly the rows the service writes. The expected
 * totals are read back from the full positions ledger.
 *
 * Fixture cleanup follows ownership, not the predeclared ID plan: a row
 * is registered only after its insert actually succeeds (INSERT …
 * RETURNING), and teardown deletes exactly the registered rows —
 * including the PredictionPriceHistory rows every service buy writes —
 * then reads back that nothing owned remains. A setup chunk that
 * collides with a pre-existing row therefore registers nothing, and the
 * pre-existing row survives teardown (see the 'fixture ownership'
 * control below).
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
  questions,
  users,
} from '@feed/db';
import { NextRequest } from 'next/server';

type DynamicsResponse = {
  totalVolume: number;
  totalPositions: number;
};

let dynamicsGET: typeof import('../../../apps/web/src/app/api/questions/[id]/dynamics/route').GET;

const suffix = crypto.randomUUID().slice(0, 8);
const busyId = `f142-dyn-busy-${suffix}`;
const quietId = `f142-dyn-quiet-${suffix}`;
const BUSY_BUYERS = 1005;
const QUIET_BUYERS = 3;
// The ID plan for fixture buyers. Planning an ID does not own the row:
// ownedUserIds below is the only list teardown may delete from.
const buyerIds: string[] = [];
for (let i = 0; i < BUSY_BUYERS + QUIET_BUYERS; i++) {
  buyerIds.push(`f142-dyn-user-${i}-${suffix}`);
}
// Route validates the path id as 1–9 digits.
let questionNumber = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const numberByQuestion = new Map<string, number>();

// Ownership registries — appended only from successful writes.
const ownedUserIds: string[] = [];
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];

type OwnedFixture = {
  userIds: string[];
  questionIds: string[];
  marketIds: string[];
};

function buyerIdAt(index: number): string {
  const id = buyerIds[index];
  if (id === undefined)
    throw new Error(`buyer fixture ID missing at index ${index}`);
  return id;
}

async function fetchDynamics(questionId: string) {
  const num = numberByQuestion.get(questionId);
  if (num === undefined)
    throw new Error(`no question number for ${questionId}`);
  const response = await dynamicsGET(
    new NextRequest(`http://localhost/api/questions/${num}/dynamics`),
    { params: Promise.resolve({ id: String(num) }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DynamicsResponse;
}

/** Ledger totals exactly as the route defines them — over ALL rows. */
async function ledgerTotals(marketId: string) {
  const rows = await db
    .select({ shares: positions.shares, avgPrice: positions.avgPrice })
    .from(positions)
    .where(eq(positions.marketId, marketId));
  return {
    count: rows.length,
    volume: rows.reduce(
      (sum, p) => sum + Number(p.shares) * Number(p.avgPrice),
      0
    ),
  };
}

/** Insert fixture users in chunks, registering only rows that were
 * actually inserted. A chunk whose insert collides registers nothing,
 * so teardown can never reach a pre-existing row through this list. */
async function insertFixtureUsers(ids: string[], registry: string[]) {
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const inserted = await db
      .insert(users)
      .values(
        chunk.map((id, j) => ({
          id,
          username: `f142dyn-${i + j}-${suffix}`,
          displayName: 'Dynamics Volume Fixture User',
          updatedAt: new Date(),
        }))
      )
      .returning({ id: users.id });
    registry.push(...inserted.map((row) => row.id));
  }
}

async function createMarket(id: string, liquidity: number): Promise<void> {
  const num = questionNumber++;
  numberByQuestion.set(id, num);
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: num,
      text: `Dynamics total volume fixture ${id}`,
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

/** Delete exactly the registered rows — derived price-history rows
 * first, then positions, markets, questions and users. Failures are
 * deliberately not swallowed: a cleanup that did not happen must fail
 * the run, not leak silently. */
async function deleteOwned(owned: OwnedFixture): Promise<void> {
  if (owned.marketIds.length > 0) {
    await db
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, owned.marketIds));
    await db
      .delete(positions)
      .where(inArray(positions.marketId, owned.marketIds));
    await db.delete(markets).where(inArray(markets.id, owned.marketIds));
  }
  if (owned.questionIds.length > 0) {
    await db.delete(questions).where(inArray(questions.id, owned.questionIds));
  }
  for (let i = 0; i < owned.userIds.length; i += 250) {
    await db
      .delete(users)
      .where(inArray(users.id, owned.userIds.slice(i, i + 250)));
  }
}

function makeService(): PredictionMarketService {
  return new PredictionMarketService({
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
}

beforeAll(async () => {
  ({ GET: dynamicsGET } = await import(
    '../../../apps/web/src/app/api/questions/[id]/dynamics/route'
  ));

  // Buyers (fixture users; the positions themselves are written by the
  // real service buy path, one row per distinct buyer).
  await insertFixtureUsers(buyerIds, ownedUserIds);

  await createMarket(busyId, 20000);
  await createMarket(quietId, 4000);

  const service = makeService();
  // Busy market: 1,005 small real buys — past the route's 1,000-row
  // sample. Every buy is the same size, so whichever rows the sample
  // drops, the dropped volume is the same.
  for (let i = 0; i < BUSY_BUYERS; i++) {
    await service.buy({
      marketId: busyId,
      userId: buyerIdAt(i),
      amount: 10,
      side: 'yes',
    });
  }
  // Quiet control market: a few buys, well under the sample size.
  for (let i = 0; i < QUIET_BUYERS; i++) {
    await service.buy({
      marketId: quietId,
      userId: buyerIdAt(BUSY_BUYERS + i),
      amount: 10,
      side: 'yes',
    });
  }
}, 600_000);

afterAll(async () => {
  await deleteOwned({
    userIds: ownedUserIds,
    questionIds: ownedQuestionIds,
    marketIds: ownedMarketIds,
  });

  // Read back: nothing the fixture owned may remain — including the
  // price-history rows the service buys wrote (one per buy).
  if (ownedMarketIds.length > 0) {
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
  }
  if (ownedQuestionIds.length > 0) {
    const leftoverQuestions = await db
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.id, ownedQuestionIds));
    expect(leftoverQuestions).toHaveLength(0);
  }
  if (ownedUserIds.length > 0) {
    const leftoverUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ownedUserIds));
    expect(leftoverUsers).toHaveLength(0);
  }
});

describe('market dynamics totals', () => {
  it('counts every position on a market past 1,000 positions', async () => {
    const ledger = await ledgerTotals(busyId);
    expect(ledger.count).toBe(BUSY_BUYERS);
    const dynamics = await fetchDynamics(busyId);
    expect(dynamics.totalPositions).toBe(BUSY_BUYERS);
  });

  it('reports totalVolume as the full positions ledger sum past 1,000 positions', async () => {
    const ledger = await ledgerTotals(busyId);
    expect(ledger.volume).toBeGreaterThan(0);
    const dynamics = await fetchDynamics(busyId);
    expect(dynamics.totalVolume).toBeCloseTo(
      Math.round(ledger.volume * 100) / 100,
      2
    );
  });

  it('still reports exact totals on a market under the sample size', async () => {
    const ledger = await ledgerTotals(quietId);
    expect(ledger.count).toBe(QUIET_BUYERS);
    const dynamics = await fetchDynamics(quietId);
    expect(dynamics.totalPositions).toBe(QUIET_BUYERS);
    expect(dynamics.totalVolume).toBeCloseTo(
      Math.round(ledger.volume * 100) / 100,
      2
    );
  });
});

describe('fixture ownership', () => {
  it('never deletes pre-existing rows when a setup insert collides', async () => {
    const victimUserId = `f142-dyn-victim-user-${suffix}`;
    const victimQuestionId = `f142-dyn-victim-q-${suffix}`;
    // Pre-existing rows this fixture never created and must never
    // delete. They are inserted directly, bypassing the ownership
    // registries.
    await db.insert(users).values({
      id: victimUserId,
      username: `f142dyn-victim-${suffix}`,
      displayName: 'Pre-existing Fixture Victim',
      updatedAt: new Date(),
    });
    const victimQuestionNumber = questionNumber++;
    await db.insert(questions).values({
      id: victimQuestionId,
      questionNumber: victimQuestionNumber,
      text: `Dynamics ownership victim ${victimQuestionId}`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 7 * 86400000),
      status: 'active',
      updatedAt: new Date(),
    });

    // A setup batch planned around the victim's ID collides on its
    // primary key. The statement inserts nothing, so the ownership
    // registry gains nothing — this is the partial-setup state the old
    // teardown mishandled by deleting from the predeclared ID plan.
    const batchRegistry: string[] = [];
    let collided = false;
    try {
      await insertFixtureUsers(
        [victimUserId, `f142-dyn-collider-${suffix}`],
        batchRegistry
      );
    } catch {
      collided = true;
    }
    expect(collided).toBe(true);
    expect(batchRegistry).toHaveLength(0);

    // Teardown against that registry must leave both victims intact.
    await deleteOwned({
      userIds: batchRegistry,
      questionIds: [],
      marketIds: [],
    });
    const [survivingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, victimUserId));
    expect(survivingUser?.id).toBe(victimUserId);
    const [survivingQuestion] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.id, victimQuestionId));
    expect(survivingQuestion?.id).toBe(victimQuestionId);

    // The control removes its own pre-existing rows directly; they were
    // never fixture-owned.
    await db.delete(users).where(eq(users.id, victimUserId));
    await db.delete(questions).where(eq(questions.id, victimQuestionId));
  });
});

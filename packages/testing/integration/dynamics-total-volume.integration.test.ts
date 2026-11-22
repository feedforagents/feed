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
 * control below). Cleanup runs in one guarded transaction: it locks the
 * owned parents, refuses the whole cleanup when a foreign child sits
 * under one of them (a foreign Position or price-history row on an
 * owned market, or a foreign ArcState on an owned Question — the
 * Question delete would otherwise cascade it away), and only then
 * deletes the registered rows by id.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  adminRoles,
  and,
  arcStates,
  db,
  eq,
  gameOnboarding,
  inArray,
  markets,
  notInArray,
  positions,
  predictionPriceHistories,
  questionArcPlans,
  questions,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
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
// Child rows the service buys write: position ids come back from
// buy(); price-history ids are found by diffing the market's history
// rows around each buy, because insertPriceSnapshot returns void.
const ownedPositionIds: string[] = [];
const ownedHistoryIds: string[] = [];

type OwnedFixture = {
  userIds: string[];
  questionIds: string[];
  marketIds: string[];
  positionIds: string[];
  historyIds: string[];
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

/** One guarded cleanup transaction: lock the owned parents, refuse
 * when a foreign child sits under one of them, and only then delete
 * exactly the registered rows by id — children first, parents last.
 * Refusal rolls the whole transaction back, so a foreign row is never
 * deleted or orphaned by this teardown. */
async function deleteOwned(owned: OwnedFixture): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock the owned parents first so no concurrent writer can slip a
    // foreign child under them between the check and the deletes.
    if (owned.marketIds.length > 0) {
      await tx
        .select({ id: markets.id })
        .from(markets)
        .where(inArray(markets.id, owned.marketIds))
        .for('update');
    }
    if (owned.questionIds.length > 0) {
      await tx
        .select({ id: questions.id })
        .from(questions)
        .where(inArray(questions.id, owned.questionIds))
        .for('update');
    }
    if (owned.userIds.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, owned.userIds))
        .for('update');
    }

    // A foreign child under an owned parent refuses the whole cleanup.
    // Positions and price history carry no foreign key, so a row on an
    // owned market that this run did not register is foreign by
    // definition; ArcState/ArcPlan rows cascade off an owned Question;
    // GameOnboarding, PnL snapshots and Whitelist rows cascade off an
    // owned User; Whitelist grantedBy / WhitelistConfig updatedBy and
    // AdminRole links would be nulled or blocked instead.
    const foreign: string[] = [];
    const check = async (
      label: string,
      rows: { id: string }[]
    ): Promise<void> => {
      for (const row of rows) foreign.push(`${label} ${row.id}`);
    };
    if (owned.marketIds.length > 0) {
      await check(
        'foreign Position on owned market',
        await tx
          .select({ id: positions.id })
          .from(positions)
          .where(
            owned.positionIds.length > 0
              ? and(
                  inArray(positions.marketId, owned.marketIds),
                  notInArray(positions.id, owned.positionIds)
                )
              : inArray(positions.marketId, owned.marketIds)
          )
      );
      await check(
        'foreign price-history row on owned market',
        await tx
          .select({ id: predictionPriceHistories.id })
          .from(predictionPriceHistories)
          .where(
            owned.historyIds.length > 0
              ? and(
                  inArray(predictionPriceHistories.marketId, owned.marketIds),
                  notInArray(predictionPriceHistories.id, owned.historyIds)
                )
              : inArray(predictionPriceHistories.marketId, owned.marketIds)
          )
      );
      await check(
        'foreign Question pointing at owned market',
        await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            owned.questionIds.length > 0
              ? and(
                  inArray(questions.marketId, owned.marketIds),
                  notInArray(questions.id, owned.questionIds)
                )
              : inArray(questions.marketId, owned.marketIds)
          )
      );
    }
    if (owned.questionIds.length > 0) {
      await check(
        'foreign ArcState on owned Question',
        await tx
          .select({ id: arcStates.id })
          .from(arcStates)
          .where(inArray(arcStates.questionId, owned.questionIds))
      );
      await check(
        'foreign QuestionArcPlan on owned Question',
        await tx
          .select({ id: questionArcPlans.id })
          .from(questionArcPlans)
          .where(inArray(questionArcPlans.questionId, owned.questionIds))
      );
    }
    if (owned.userIds.length > 0) {
      await check(
        'foreign GameOnboarding on owned User',
        await tx
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, owned.userIds))
      );
      await check(
        'foreign UserPnLSnapshot on owned User',
        await tx
          .select({ id: userPnLSnapshots.id })
          .from(userPnLSnapshots)
          .where(inArray(userPnLSnapshots.userId, owned.userIds))
      );
      await check(
        'foreign Whitelist row on owned User',
        await tx
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(inArray(whitelist.userId, owned.userIds))
      );
      await check(
        'foreign Whitelist row granted by owned User',
        await tx
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(inArray(whitelist.grantedBy, owned.userIds))
      );
      await check(
        'foreign WhitelistConfig updated by owned User',
        await tx
          .select({ id: whitelistConfig.id })
          .from(whitelistConfig)
          .where(inArray(whitelistConfig.updatedBy, owned.userIds))
      );
      await check(
        'foreign AdminRole on owned User',
        await tx
          .select({ id: adminRoles.id })
          .from(adminRoles)
          .where(inArray(adminRoles.userId, owned.userIds))
      );
      await check(
        'foreign AdminRole granted by owned User',
        await tx
          .select({ id: adminRoles.id })
          .from(adminRoles)
          .where(inArray(adminRoles.grantedBy, owned.userIds))
      );
    }
    if (foreign.length > 0) {
      throw new Error(
        `cleanup refused: foreign rows under owned fixtures: ${foreign.slice(0, 5).join('; ')}${foreign.length > 5 ? ` (+${foreign.length - 5} more)` : ''}`
      );
    }

    // Delete exactly the registered rows, children first.
    if (owned.historyIds.length > 0) {
      await tx
        .delete(predictionPriceHistories)
        .where(inArray(predictionPriceHistories.id, owned.historyIds));
    }
    if (owned.positionIds.length > 0) {
      await tx
        .delete(positions)
        .where(inArray(positions.id, owned.positionIds));
    }
    if (owned.marketIds.length > 0) {
      await tx.delete(markets).where(inArray(markets.id, owned.marketIds));
    }
    if (owned.questionIds.length > 0) {
      await tx
        .delete(questions)
        .where(inArray(questions.id, owned.questionIds));
    }
    for (let i = 0; i < owned.userIds.length; i += 250) {
      await tx
        .delete(users)
        .where(inArray(users.id, owned.userIds.slice(i, i + 250)));
    }
  });
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

/** One real buy, registering exactly the rows it wrote: the position
 * id comes back from buy(), and the price-history row is the one
 * history id that appears for the market around this single buy
 * (insertPriceSnapshot returns void, so the per-buy diff is the only
 * attribution available without changing production code). Anything
 * other than exactly one new history row fails fast instead of
 * misattributing a foreign writer's row. */
async function buyAndRegister(
  service: PredictionMarketService,
  marketId: string,
  userId: string
): Promise<void> {
  const before = new Set(
    (
      await db
        .select({ id: predictionPriceHistories.id })
        .from(predictionPriceHistories)
        .where(eq(predictionPriceHistories.marketId, marketId))
    ).map((row) => row.id)
  );
  const result = await service.buy({
    marketId,
    userId,
    amount: 10,
    side: 'yes',
  });
  ownedPositionIds.push(result.positionId);
  const after = await db
    .select({ id: predictionPriceHistories.id })
    .from(predictionPriceHistories)
    .where(eq(predictionPriceHistories.marketId, marketId));
  const fresh = after.map((row) => row.id).filter((id) => !before.has(id));
  if (fresh.length !== 1) {
    throw new Error(
      `expected exactly one new price-history row for buy on ${marketId}, got ${fresh.length}`
    );
  }
  ownedHistoryIds.push(...fresh);
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
    await buyAndRegister(service, busyId, buyerIdAt(i));
  }
  // Quiet control market: a few buys, well under the sample size.
  for (let i = 0; i < QUIET_BUYERS; i++) {
    await buyAndRegister(service, quietId, buyerIdAt(BUSY_BUYERS + i));
  }
}, 600_000);

afterAll(async () => {
  await deleteOwned({
    userIds: ownedUserIds,
    questionIds: ownedQuestionIds,
    marketIds: ownedMarketIds,
    positionIds: ownedPositionIds,
    historyIds: ownedHistoryIds,
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
      positionIds: [],
      historyIds: [],
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

  it('refuses cleanup when foreign children sit under owned parents', async () => {
    // Foreign rows this run never created, planted under owned
    // parents: a Position and a price-history row on the busy market,
    // an ArcState on the busy Question, and a GameOnboarding row on a
    // fixture buyer. The old teardown deleted the Position/history
    // rows by marketId and cascaded the ArcState away with the
    // Question; the guarded cleanup must refuse instead.
    const foreignUserId = `f142-dyn-foreign-user-${suffix}`;
    const foreignPositionId = `f142-dyn-foreign-pos-${suffix}`;
    const foreignHistoryId = `f142-dyn-foreign-hist-${suffix}`;
    const foreignArcId = `f142-dyn-foreign-arc-${suffix}`;
    const foreignOnboardingId = `f142-dyn-foreign-onb-${suffix}`;
    await db.insert(users).values({
      id: foreignUserId,
      username: `f142dyn-foreign-${suffix}`,
      displayName: 'Pre-existing Foreign User',
      updatedAt: new Date(),
    });
    await db.insert(positions).values({
      id: foreignPositionId,
      userId: foreignUserId,
      marketId: busyId,
      side: true,
      shares: '1',
      avgPrice: '0.5',
      amount: '10',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(predictionPriceHistories).values({
      id: foreignHistoryId,
      marketId: busyId,
      yesPrice: 0.5,
      noPrice: 0.5,
      yesShares: '100',
      noShares: '100',
      liquidity: '200',
      eventType: 'trade',
      source: 'user_trade',
    });
    await db.insert(arcStates).values({
      id: foreignArcId,
      questionId: busyId,
      currentState: 'setup',
      stateEnteredAt: new Date(),
    });
    await db.insert(gameOnboarding).values({
      id: foreignOnboardingId,
      userId: buyerIdAt(0),
    });

    // The full cleanup must refuse and roll back: nothing may be
    // deleted while the foreign rows are there.
    await expect(
      deleteOwned({
        userIds: ownedUserIds,
        questionIds: ownedQuestionIds,
        marketIds: ownedMarketIds,
        positionIds: ownedPositionIds,
        historyIds: ownedHistoryIds,
      })
    ).rejects.toThrow(/cleanup refused/);

    const [survivingPosition] = await db
      .select({ id: positions.id })
      .from(positions)
      .where(eq(positions.id, foreignPositionId));
    expect(survivingPosition?.id).toBe(foreignPositionId);
    const [survivingHistory] = await db
      .select({ id: predictionPriceHistories.id })
      .from(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, foreignHistoryId));
    expect(survivingHistory?.id).toBe(foreignHistoryId);
    const [survivingArc] = await db
      .select({ id: arcStates.id })
      .from(arcStates)
      .where(eq(arcStates.id, foreignArcId));
    expect(survivingArc?.id).toBe(foreignArcId);
    const [survivingOnboarding] = await db
      .select({ id: gameOnboarding.id })
      .from(gameOnboarding)
      .where(eq(gameOnboarding.id, foreignOnboardingId));
    expect(survivingOnboarding?.id).toBe(foreignOnboardingId);
    // Owned parents and a sample of owned children must survive too.
    const [survivingMarket] = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, busyId));
    expect(survivingMarket?.id).toBe(busyId);
    const [survivingQuestion] = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.id, busyId));
    expect(survivingQuestion?.id).toBe(busyId);
    const [survivingOwnedPosition] = await db
      .select({ id: positions.id })
      .from(positions)
      .where(eq(positions.id, ownedPositionIds[0] ?? ''));
    expect(survivingOwnedPosition?.id).toBe(ownedPositionIds[0]);
    const [survivingOwnedHistory] = await db
      .select({ id: predictionPriceHistories.id })
      .from(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, ownedHistoryIds[0] ?? ''));
    expect(survivingOwnedHistory?.id).toBe(ownedHistoryIds[0]);

    // The control removes its own foreign rows directly; the real
    // afterAll cleanup below can then proceed.
    await db.delete(arcStates).where(eq(arcStates.id, foreignArcId));
    await db
      .delete(gameOnboarding)
      .where(eq(gameOnboarding.id, foreignOnboardingId));
    await db.delete(positions).where(eq(positions.id, foreignPositionId));
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, foreignHistoryId));
    await db.delete(users).where(eq(users.id, foreignUserId));
  });
});

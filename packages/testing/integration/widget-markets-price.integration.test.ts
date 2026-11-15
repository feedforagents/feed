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
 * clause (or, for server-generated ids, from the trade's own return
 * value, or from a before/after id-set diff of the trade's snapshots),
 * and teardown deletes only those owned rows by id — including the
 * PredictionPriceHistory rows the real trades write, which have no
 * cascading FK. A market is only adopted when the row read back after
 * creation is the row this fixture just inserted: the adapter's
 * createMarketFromQuestion returns the existing row on a lost race (ON
 * CONFLICT DO NOTHING), so the receipt requires the fixture's own
 * acquisition marker in the row's description — a unique string only
 * this call writes — as well as the fixture's question text and a
 * createdAt at or after the creation call. Trade snapshots are adopted
 * by id-set diff (rows present after the trade that were absent
 * before it), never by a time window and count, so a foreign row
 * written mid-trade is refused instead of adopted. Teardown first
 * refuses, in one transaction, any foreign dependent under an owned
 * parent (positions/history under owned markets, ArcState and the
 * other cascade children under owned questions, GameOnboarding and
 * the other user children) before deleting anything. The
 * zero-leftover check stays scoped by marketId as detection — if a
 * foreign row ever appears under an owned market, the suite fails
 * instead of deleting it. A setup collision (a second insert under an
 * owned id) must reject instead of silently reusing or overwriting
 * the fixture.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { CACHE_KEYS, invalidateCache, isRedisAvailable } from '@feed/api';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  and,
  arcStates,
  closeDatabase,
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
  sql,
  timeframedMarkets,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
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

// Rows this file owns, recorded from each insert's RETURNING clause
// (or, for server-generated ids, from the trade's own return value).
// Teardown deletes only these by id — never the preallocated ids as
// such, and never every row under an owned market.
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
const ownedHistoryIds: string[] = [];
const ownedPositionIds: string[] = [];
let ownedUserId: string | null = null;

/**
 * Acquisition receipt for a market: the row read back after creation
 * must be the row this fixture just inserted — its question text, a
 * createdAt at or after the creation call, and the acquisition marker
 * this call wrote into the row's description. createMarketFromQuestion
 * uses ON CONFLICT DO NOTHING and returns the existing row when the
 * insert loses a race, so a matching id alone proves nothing, and a
 * timestamp alone does not either: another actor creating a market
 * for the same question inside the same window produces the same text
 * and createdAt. The marker is a unique string only this call writes,
 * so a row created by another actor — same text, same window, no
 * marker — is refused here instead of adopted into ownedMarketIds.
 */
async function verifyMarketAcquired(
  marketId: string,
  acquiredAt: Date,
  expectedQuestionText: string,
  expectedDescription: string
): Promise<void> {
  const [row] = await db
    .select({
      question: markets.question,
      description: markets.description,
      createdAt: markets.createdAt,
    })
    .from(markets)
    .where(eq(markets.id, marketId));
  if (!row) throw new Error(`market ${marketId} is missing after creation`);
  if (
    row.question !== expectedQuestionText ||
    row.description !== expectedDescription ||
    row.createdAt < acquiredAt
  ) {
    throw new Error(
      `market ${marketId} was not acquired by this fixture: the row was created by another actor (existing-row fallback)`
    );
  }
}

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
  const acquiredAt = new Date();
  // The marker is the physical insertion receipt: only this call
  // writes it into the market row's description (see
  // verifyMarketAcquired).
  const acquisitionMarker = `Widget price fixture acquisition ${id}`;
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    // 10,000,000 liquidity, so the fixture's volume (~10M, score
    // ~7M) deterministically occupies the widget's top-ten slice in
    // the shared CI database: at 10,000 liquidity the score was
    // ~7,230 and other suites' markets crowded the fixtures out of
    // the list. Prices are ratios, so the larger pool changes no
    // assertion — every price case reads the detail route as ground
    // truth from the same pool state.
    10_000_000,
    { initialYesProbability, description: acquisitionMarker }
  );
  await verifyMarketAcquired(
    market.id,
    acquiredAt,
    `Widget price fixture ${id}`,
    acquisitionMarker
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
  ownedHistoryIds.push(row.id);
}

/**
 * Trade snapshots carry server-generated ids, so they cannot be taken
 * from a RETURNING clause. Collect them by id-set diff: the rows
 * present after the trade that were absent before it — and refuse
 * unless exactly the number of trades this fixture ran wrote them.
 * A time window plus a count cannot prove ownership: a foreign actor
 * writing inside the window and padding the count to match would be
 * adopted. The diff refuses that — any row the fixture did not write
 * shows up as an extra id.
 */
async function historyIds(marketId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: predictionPriceHistories.id })
    .from(predictionPriceHistories)
    .where(eq(predictionPriceHistories.marketId, marketId));
  return new Set(rows.map((r) => r.id));
}

async function collectTradeSnapshots(
  marketId: string,
  beforeIds: Set<string>,
  expectedCount: number
): Promise<void> {
  const afterIds = await historyIds(marketId);
  const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
  if (newIds.length !== expectedCount) {
    throw new Error(
      `expected ${expectedCount} new trade snapshots for ${marketId}, found ${newIds.length} — refusing to adopt foreign rows`
    );
  }
  ownedHistoryIds.push(...newIds);
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

  // Skewed pool: seeded at an 80% YES probability (yes 2,000,000 /
  // no 8,000,000), with a recorded 0.5 price just outside the 24h
  // window.
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
    const oldRows = Array.from({ length: 500 }, (_, i) => ({
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
    }));
    await db.insert(predictionPriceHistories).values(oldRows);
    ownedHistoryIds.push(...oldRows.map((r) => r.id));
  }
  const tieTime = new Date(Date.now() - 26 * 3600_000);
  const tieRows = ['a', 'z'].map((label) => ({
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
  }));
  await db.insert(predictionPriceHistories).values(tieRows);
  ownedHistoryIds.push(...tieRows.map((r) => r.id));

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
  const buyBeforeIds = await historyIds(tradedBuyId);
  const sellBeforeIds = await historyIds(tradedSellId);
  const buyResult = await service.buy({
    marketId: tradedBuyId,
    userId,
    amount: 1000,
    side: 'yes',
  });
  ownedPositionIds.push(buyResult.positionId);
  const sellBuy = await service.buy({
    marketId: tradedSellId,
    userId,
    amount: 1000,
    side: 'yes',
  });
  ownedPositionIds.push(sellBuy.positionId);
  await service.sell({
    marketId: tradedSellId,
    userId,
    shares: 500,
    positionId: sellBuy.positionId,
  });
  // One snapshot per trade: the buy market wrote 1, the buy+sell
  // market wrote 2. Anything else in the id diff is foreign.
  await collectTradeSnapshots(tradedBuyId, buyBeforeIds, 1);
  await collectTradeSnapshots(tradedSellId, sellBeforeIds, 2);
  // The first price case must read a fresh list even if this file
  // runs twice in one process: the widget cache is five minutes.
  await invalidateCache('markets-widget-v3', { namespace: CACHE_KEYS.WIDGET });
});

afterAll(async () => {
  expect(isRedisAvailable()).toBe(false);
  await invalidateCache('markets-widget-v3', { namespace: CACHE_KEYS.WIDGET });
  // Refuse, then delete, in one transaction. The refusal pass runs
  // BEFORE any parent is deleted — a check after deleting the
  // Market/Question rows could not preserve them — and the owned
  // parent rows are locked FOR UPDATE first, so a foreign dependent
  // cannot be inserted (its FK takes a key-share lock on the parent)
  // between the check and the delete. Any refusal throws, the
  // transaction rolls back, and nothing is deleted. The real trades
  // also wrote PredictionPriceHistory rows (no cascading FK), so
  // owned history goes first. Any failure throws — cleanup is never
  // swallowed — and the deleted counts prove exactly the owned rows
  // were removed. The zero-checks below stay scoped by marketId as
  // detection: if a foreign row ever appears under an owned market,
  // the suite fails here instead of deleting it.
  await db.transaction(async (tx) => {
    if (ownedMarketIds.length > 0) {
      await tx
        .select({ id: markets.id })
        .from(markets)
        .where(inArray(markets.id, ownedMarketIds))
        .for('update');
    }
    if (ownedQuestionIds.length > 0) {
      await tx
        .select({ id: questions.id })
        .from(questions)
        .where(inArray(questions.id, ownedQuestionIds))
        .for('update');
    }
    if (ownedUserId) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, ownedUserId))
        .for('update');
    }
    // Foreign dependents under owned parents — refuse them all
    // before deleting anything. (When an owned-id list is empty,
    // every row under the owned parent is foreign by definition.)
    const foreignPositions = await tx
      .select({ id: positions.id })
      .from(positions)
      .where(
        ownedPositionIds.length > 0
          ? and(
              inArray(positions.marketId, ownedMarketIds),
              notInArray(positions.id, ownedPositionIds)
            )
          : inArray(positions.marketId, ownedMarketIds)
      );
    if (foreignPositions.length > 0) {
      throw new Error(
        `refusing teardown: ${foreignPositions.length} foreign Position rows under owned markets`
      );
    }
    const foreignHistory = await tx
      .select({ id: predictionPriceHistories.id })
      .from(predictionPriceHistories)
      .where(
        ownedHistoryIds.length > 0
          ? and(
              inArray(predictionPriceHistories.marketId, ownedMarketIds),
              notInArray(predictionPriceHistories.id, ownedHistoryIds)
            )
          : inArray(predictionPriceHistories.marketId, ownedMarketIds)
      );
    if (foreignHistory.length > 0) {
      throw new Error(
        `refusing teardown: ${foreignHistory.length} foreign PredictionPriceHistory rows under owned markets`
      );
    }
    // Cascade children under owned questions: deleting a Question
    // would silently delete these.
    const foreignArcStates = await tx
      .select({ id: arcStates.id })
      .from(arcStates)
      .where(inArray(arcStates.questionId, ownedQuestionIds));
    if (foreignArcStates.length > 0) {
      throw new Error(
        `refusing teardown: ${foreignArcStates.length} foreign ArcState rows under owned questions`
      );
    }
    const foreignArcPlans = await tx
      .select({ id: questionArcPlans.id })
      .from(questionArcPlans)
      .where(inArray(questionArcPlans.questionId, ownedQuestionIds));
    if (foreignArcPlans.length > 0) {
      throw new Error(
        `refusing teardown: ${foreignArcPlans.length} foreign QuestionArcPlan rows under owned questions`
      );
    }
    const foreignTimeframed = await tx
      .select({ id: timeframedMarkets.id })
      .from(timeframedMarkets)
      .where(inArray(timeframedMarkets.questionId, ownedQuestionIds));
    if (foreignTimeframed.length > 0) {
      throw new Error(
        `refusing teardown: ${foreignTimeframed.length} foreign TimeframedMarket rows under owned questions`
      );
    }
    // Cascade / set-null children of the fixture user: deleting the
    // user would silently delete or null these.
    if (ownedUserId) {
      const foreignOnboarding = await tx
        .select({ id: gameOnboarding.id })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.userId, ownedUserId));
      if (foreignOnboarding.length > 0) {
        throw new Error(
          'refusing teardown: foreign GameOnboarding rows under the fixture user'
        );
      }
      const foreignSnapshots = await tx
        .select({ id: userPnLSnapshots.id })
        .from(userPnLSnapshots)
        .where(eq(userPnLSnapshots.userId, ownedUserId));
      if (foreignSnapshots.length > 0) {
        throw new Error(
          'refusing teardown: foreign UserPnLSnapshot rows under the fixture user'
        );
      }
      // A Whitelist row for the fixture user is foreign — this file
      // never creates one.
      const foreignWhitelistByUser = await tx
        .select({ id: whitelist.id })
        .from(whitelist)
        .where(eq(whitelist.userId, ownedUserId));
      if (foreignWhitelistByUser.length > 0) {
        throw new Error(
          'refusing teardown: foreign Whitelist rows under the fixture user'
        );
      }
      const foreignGrantedBy = await tx
        .select({ id: whitelist.id })
        .from(whitelist)
        .where(eq(whitelist.grantedBy, ownedUserId));
      if (foreignGrantedBy.length > 0) {
        throw new Error(
          'refusing teardown: foreign Whitelist rows granted by the fixture user'
        );
      }
      const foreignConfig = await tx
        .select({ id: whitelistConfig.id })
        .from(whitelistConfig)
        .where(eq(whitelistConfig.updatedBy, ownedUserId));
      if (foreignConfig.length > 0) {
        throw new Error(
          'refusing teardown: foreign WhitelistConfig rows updated by the fixture user'
        );
      }
    }

    // Delete only owned rows, by id, in dependency order.
    const deletedHistory = await tx
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.id, ownedHistoryIds))
      .returning({ id: predictionPriceHistories.id });
    const deletedPositions = await tx
      .delete(positions)
      .where(inArray(positions.id, ownedPositionIds))
      .returning({ id: positions.id });
    const deletedMarkets = await tx
      .delete(markets)
      .where(inArray(markets.id, ownedMarketIds))
      .returning({ id: markets.id });
    const deletedQuestions = await tx
      .delete(questions)
      .where(inArray(questions.id, ownedQuestionIds))
      .returning({ id: questions.id });
    if (ownedUserId) {
      const deletedUsers = await tx
        .delete(users)
        .where(eq(users.id, ownedUserId))
        .returning({ id: users.id });
      expect(deletedUsers.length).toBe(1);
    }
    expect(deletedHistory.length).toBe(ownedHistoryIds.length);
    expect(deletedPositions.length).toBe(ownedPositionIds.length);
    expect(deletedMarkets.length).toBe(ownedMarketIds.length);
    expect(deletedQuestions.length).toBe(ownedQuestionIds.length);
  });

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

  it('refuses the adapter existing-row fallback instead of adopting the market', async () => {
    const [question] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, skewedId))
      .limit(1);
    if (!question) throw new Error('skewed fixture question is missing');
    // The adapter hands the existing row back on a lost race instead
    // of failing — that return must never count as acquiring it.
    const returned = await new PredictionDbAdapter().createMarketFromQuestion(
      { ...question, status: 'active' as const },
      10000,
      { initialYesProbability: 0.8 }
    );
    expect(returned.id).toBe(skewedId);
    // The row is this fixture's own (its description still carries
    // our acquisition marker), but it predates this call, so the
    // acquisition receipt refuses it on the timestamp leg; the
    // fixture still owns the market exactly once.
    await expect(
      verifyMarketAcquired(
        skewedId,
        new Date(),
        `Widget price fixture ${skewedId}`,
        `Widget price fixture acquisition ${skewedId}`
      )
    ).rejects.toThrow(/not acquired/);
    expect(ownedMarketIds.filter((id) => id === skewedId)).toHaveLength(1);
  });

  it('refuses a same-question market created by another actor inside the acquisition window', async () => {
    const raceId = `f43-wmp-race-${suffix}`;
    const raceText = `Widget price fixture ${raceId}`;
    const [question] = await db
      .insert(questions)
      .values({
        id: raceId,
        questionNumber: questionNumber++,
        text: raceText,
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
    if (!question) throw new Error('race probe question insert failed');
    // Stamp the acquisition window first, then let the foreign actor
    // create the market for the same question inside that window:
    // same text, same createdAt window — only the description marker
    // can tell the rows apart.
    const acquiredAt = new Date();
    const [foreign] = await db
      .insert(markets)
      .values({
        id: raceId,
        question: raceText,
        description: 'foreign-race',
        gameId: 'continuous',
        dayNumber: null,
        yesShares: '2000',
        noShares: '8000',
        liquidity: '10000',
        resolved: false,
        resolution: null,
        endDate: question.resolutionDate,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolutionProofUrl: null,
        resolutionDescription: null,
      })
      .returning({ id: markets.id, createdAt: markets.createdAt });
    if (!foreign) throw new Error('race probe market insert failed');
    expect(foreign.createdAt >= acquiredAt).toBe(true);
    const raceMarker = `Widget price fixture acquisition ${raceId}`;
    const returned = await new PredictionDbAdapter().createMarketFromQuestion(
      { ...question, status: 'active' as const },
      10000,
      { initialYesProbability: 0.8, description: raceMarker }
    );
    expect(returned.id).toBe(raceId);
    // The timestamp leg alone would accept this row — it was created
    // inside the window — so the refusal must come from the marker.
    await expect(
      verifyMarketAcquired(raceId, acquiredAt, raceText, raceMarker)
    ).rejects.toThrow(/not acquired/);
    expect(ownedMarketIds).not.toContain(raceId);
    // The probe cleans up its own rows; they were never adopted.
    await db.delete(markets).where(eq(markets.id, raceId));
    await db.delete(questions).where(eq(questions.id, raceId));
  });

  it('refuses foreign child rows: history written by another actor under an owned market is never adopted', async () => {
    const foreignId = `f43-wmp-foreign-${suffix}`;
    await db.insert(predictionPriceHistories).values({
      id: foreignId,
      marketId: skewedId,
      yesPrice: 0.9,
      noPrice: 0.1,
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      eventType: 'trade',
      source: 'system',
      createdAt: new Date(),
    });
    // The owned-id registry must not pick it up: teardown deletes by
    // owned ids only, so this row is outside the fixture's cleanup
    // scope even though it sits under an owned market.
    expect(ownedHistoryIds).not.toContain(foreignId);
    const rows = await db
      .select({ id: predictionPriceHistories.id })
      .from(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, foreignId));
    expect(rows).toHaveLength(1);
    // Remove the probe row itself so afterAll's zero-leftover check
    // still proves the fixture left nothing behind.
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.id, foreignId));
  });
});

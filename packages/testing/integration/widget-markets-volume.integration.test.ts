/**
 * GET /api/feed/widgets/markets against a real database: the "Vol" number
 * the sidebar widget prints under a market (with the Feed Points currency
 * symbol) must be the market's traded volume, and the widget's popularity
 * sort (70% weight on this field) must consume the same value.
 *
 * Traded volume is the all-time sum of amount (shares × trade price) over
 * the market's append-only trade ledger (PredictionTrade): every buy and
 * every sell appends one row — the same aggregate the markets list route
 * reports as volume. The widget route instead reported the pool's current
 * share balances (yesShares + noShares), so a freshly seeded market with
 * zero trades showed "Vol 10,000" (its seed liquidity) and the figure
 * moved with pool balances rather than with trading activity. Summing the
 * current positions (shares × avgPrice) is not a fix either: the real
 * sell path reduces position shares on a partial sell and zeroes them on
 * a full close, so additional trading can reduce that figure and a
 * completed buy/sell roundtrip contributes zero.
 *
 * Fixtures are built with the real creation path
 * (PredictionDbAdapter.createMarketFromQuestion) and real trades through
 * PredictionMarketService. The expected volume is read from the trade
 * ledger itself. All trades happen in beforeAll: the anonymous widget
 * response is cached for five minutes, so a trade placed after the first
 * fetch would not be visible to later fetches.
 *
 * Ownership: fixture ids are registered only from successful INSERT …
 * RETURNING results (and, for markets, only when the adapter's insert
 * actually created the row — on conflict it returns the pre-existing
 * market, which this fixture does not own). Teardown deletes only
 * registered rows, including the derived PredictionTrade and
 * PredictionPriceHistory rows a real trade leaves behind, and reads back
 * zero remaining fixture rows.
 *
 * Backfill: one more market carries pre-migration history only as
 * wallet-ledger rows (BalanceTransaction 'pred_buy' / 'pred_sell',
 * no PredictionTrade rows). beforeAll runs the backfill INSERT from
 * migration 0005 against those rows — twice, so the test also proves
 * the insert is idempotent — and the widget must then report the
 * ledger sum for that market.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { readFile } from 'node:fs/promises';

mock.module('server-only', () => ({}));

import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import {
  balanceTransactions,
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
import { sql } from 'drizzle-orm';
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
const partialId = `f112-wmv-partial-${suffix}`;
const closedId = `f112-wmv-closed-${suffix}`;
const backfilledId = `f112-wmv-backfilled-${suffix}`;
// Ownership is registered only from successful INSERT … RETURNING results.
const ownedUserIds: string[] = [];
const ownedQuestionIds: string[] = [];
const ownedMarketIds: string[] = [];
let questionNumber = 1_850_000_000 + Math.floor(Math.random() * 100_000_000);
let service: PredictionMarketService;

async function fetchWidget() {
  const response = await widgetGET(
    new NextRequest('http://localhost/api/feed/widgets/markets')
  );
  return (await response.json()) as WidgetResponse;
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
  ownedQuestionIds.push(question.id);
  const existing = await db
    .select({ id: markets.id })
    .from(markets)
    .where(eq(markets.id, id));
  const market = await new PredictionDbAdapter().createMarketFromQuestion(
    { ...question, status: 'active' as const },
    10000,
    { initialYesProbability: 0.5 }
  );
  // The adapter returns an existing market after an insert conflict; only
  // a market this fixture actually inserted is owned.
  if (existing.length === 0) ownedMarketIds.push(market.id);
}

async function buyYes(marketId: string, amount: number): Promise<void> {
  await service.buy({ marketId, userId, amount, side: 'yes' });
}

async function sellYes(marketId: string, shares: number): Promise<void> {
  const position = await new PredictionDbAdapter().getPosition(
    userId,
    marketId,
    'yes'
  );
  if (!position) throw new Error(`no YES position for ${marketId}`);
  await service.sell({ marketId, userId, shares, positionId: position.id });
}

/**
 * Run the backfill INSERT from migration 0005, exactly as the migration
 * ships it (single source of truth — the test fails if the statement
 * drifts from the file). The statement is idempotent
 * (ON CONFLICT DO NOTHING on the 'backfill-<ledger id>' key).
 */
async function runBackfill(): Promise<void> {
  const migration = await readFile(
    new URL(
      '../../db/drizzle/migrations/0005_remarkable_dorian_gray.sql',
      import.meta.url
    ),
    'utf8'
  );
  const statement = migration
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .find((part) => part.includes('backfill-'));
  if (!statement) {
    throw new Error('backfill statement missing from 0005 migration');
  }
  await db.execute(sql.raw(statement));
}

beforeAll(async () => {
  ({ GET: widgetGET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/markets/route'
  ));

  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      username: `f112wmv-${suffix}`,
      displayName: 'Widget Volume Fixture User',
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error(`user insert failed for ${userId}`);
  ownedUserIds.push(user.id);

  // Idle market: seeded with liquidity, never traded.
  await createMarket(idleId);
  // Traded market: seeded the same way, then one real YES buy.
  await createMarket(tradedId);
  // Partial-sell market: one buy, then half the position sold.
  await createMarket(partialId);
  // Full-close market: one buy, then the whole position sold.
  await createMarket(closedId);
  // Backfilled market: pre-migration history exists only as wallet-ledger
  // rows — a 1000 buy and a 250 sell, no PredictionTrade rows. The
  // backfill must carry the 1250 ledger sum into the trade ledger.
  await createMarket(backfilledId);
  await db.insert(balanceTransactions).values([
    {
      id: `f112-wmv-bt-buy-${suffix}`,
      userId,
      type: 'pred_buy',
      amount: '1000.00',
      balanceBefore: '10000.00',
      balanceAfter: '9000.00',
      relatedId: backfilledId,
      description: 'Buy YES in backfill fixture',
    },
    {
      id: `f112-wmv-bt-sell-${suffix}`,
      userId,
      type: 'pred_sell',
      amount: '250.00',
      balanceBefore: '9000.00',
      balanceAfter: '9250.00',
      relatedId: backfilledId,
      description: 'Sell YES in backfill fixture',
    },
  ]);
  await runBackfill();
  await runBackfill();

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

  await buyYes(tradedId, 1000);

  await buyYes(partialId, 1000);
  const partialBought = await positionShares(partialId);
  if (partialBought <= 0) throw new Error('partial fixture buy left no shares');
  await sellYes(partialId, partialBought / 2);

  await buyYes(closedId, 1000);
  const closedBought = await positionShares(closedId);
  if (closedBought <= 0) throw new Error('closed fixture buy left no shares');
  await sellYes(closedId, closedBought);
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
  await db
    .delete(balanceTransactions)
    .where(inArray(balanceTransactions.relatedId, ownedMarketIds));
  await db.delete(markets).where(inArray(markets.id, ownedMarketIds));
  await db.delete(questions).where(inArray(questions.id, ownedQuestionIds));
  await db.delete(users).where(inArray(users.id, ownedUserIds));

  // Residue readback: nothing owned may survive the run.
  const [
    tradeRows,
    historyRows,
    positionRows,
    ledgerRows,
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
    db
      .select()
      .from(balanceTransactions)
      .where(inArray(balanceTransactions.relatedId, ownedMarketIds)),
    db.select().from(markets).where(inArray(markets.id, ownedMarketIds)),
    db.select().from(questions).where(inArray(questions.id, ownedQuestionIds)),
    db.select().from(users).where(inArray(users.id, ownedUserIds)),
  ]);
  expect(tradeRows).toHaveLength(0);
  expect(historyRows).toHaveLength(0);
  expect(positionRows).toHaveLength(0);
  expect(ledgerRows).toHaveLength(0);
  expect(marketRows).toHaveLength(0);
  expect(questionRows).toHaveLength(0);
  expect(userRows).toHaveLength(0);
});

describe('markets widget volume', () => {
  it('shows zero volume for a seeded market with no trades', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === idleId);
    expect(row).toBeDefined();
    expect(await ledgerVolume(idleId)).toBe(0);
    expect(row?.volume).toBe(0);
  });

  it('shows the traded volume from the trade ledger after a real trade', async () => {
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === tradedId);
    expect(row).toBeDefined();
    const expected = await ledgerVolume(tradedId);
    expect(expected).toBeGreaterThan(0);
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
  });

  it('shows pre-migration wallet-ledger volume after the 0005 backfill', async () => {
    // No real trade ever ran on this market: its only history is the two
    // wallet-ledger rows the backfill carried into PredictionTrade.
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === backfilledId);
    expect(row).toBeDefined();
    expect(row?.volume ?? -1).toBeCloseTo(1250, 6);
    const rows = await db
      .select()
      .from(predictionTrades)
      .where(eq(predictionTrades.marketId, backfilledId));
    // The backfill ran twice in setup; the second run must not duplicate.
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, r) => sum + Number(r.amount), 0)).toBeCloseTo(
      1250,
      6
    );
  });

  it('keeps volume after a partial sell — the sell adds to the ledger', async () => {
    // The position was halved by the sell, so a positions-based sum would
    // report roughly half the buy alone; the ledger holds buy + sell.
    const remaining = await positionShares(partialId);
    const boughtAll = await ledgerVolume(partialId);
    expect(remaining).toBeGreaterThan(0);
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === partialId);
    expect(row).toBeDefined();
    expect(boughtAll).toBeGreaterThan(1000);
    expect(row?.volume ?? -1).toBeCloseTo(boughtAll, 6);
  });

  it('keeps volume after a full close, when no position remains', async () => {
    // The old positions-based definition reported zero here.
    expect(await positionShares(closedId)).toBe(0);
    const expected = await ledgerVolume(closedId);
    expect(expected).toBeGreaterThan(0);
    const widget = await fetchWidget();
    const row = widget.markets.find((m) => m.id === closedId);
    expect(row).toBeDefined();
    expect(row?.volume ?? -1).toBeCloseTo(expected, 6);
    expect(row?.volume ?? 0).toBeGreaterThan(0);
  });

  it('ranks the fully closed market above the idle one — the sort consumes the same volume', async () => {
    const widget = await fetchWidget();
    const ids = widget.markets.map((m) => m.id);
    const closedIndex = ids.indexOf(closedId);
    const idleIndex = ids.indexOf(idleId);
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    // Pool balances are ~equal across the fixtures (same seed), so only
    // the ledger volume can put the traded-then-closed market first.
    expect(closedIndex).toBeLessThan(idleIndex);
  });
});

describe('fixture ownership', () => {
  it('never deletes pre-existing rows when a setup insert collides', async () => {
    const foreignUserId = `f112-wmv-foreign-user-${suffix}`;
    const foreignQuestionId = `f112-wmv-foreign-q-${suffix}`;
    const ownedOnlyId = `f112-wmv-owned-user-${suffix}`;

    // Rows the fixture does not own, created before the setup runs.
    const [foreignUser] = await db
      .insert(users)
      .values({
        id: foreignUserId,
        username: `f112foreign-${suffix}`,
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
          id: ownedOnlyId,
          username: `f112owned-${suffix}`,
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
            username: `f112collision-${suffix}`,
            displayName: 'Collision',
            updatedAt: new Date(),
          })
          .returning();
      } catch {
        colliding = [];
      }
      expect(colliding).toHaveLength(0);

      // The same cleanup the suite teardown runs, scoped to owned ids only.
      if (ownedIds.length > 0) {
        await db.delete(users).where(inArray(users.id, ownedIds));
      }

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
        .where(eq(users.id, ownedOnlyId));
      expect(ownedAfter).toBeUndefined();
    } finally {
      // Leave no trace of the foreign rows either.
      await db.delete(users).where(eq(users.id, foreignUserId));
      await db.delete(questions).where(eq(questions.id, foreignQuestionId));
    }
  });

  it('does not own a market the adapter returned from an insert conflict', async () => {
    const foreignQuestionId = `f112-wmv-foreign-mkt-${suffix}`;
    const adapter = new PredictionDbAdapter();

    const [foreignQuestion] = await db
      .insert(questions)
      .values({
        id: foreignQuestionId,
        questionNumber: questionNumber++,
        text: `Foreign market fixture question ${suffix}`,
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 7 * 86400000),
        status: 'active',
        updatedAt: new Date(),
      })
      .returning();
    if (!foreignQuestion) {
      throw new Error(
        `foreign question insert failed for ${foreignQuestionId}`
      );
    }
    expect(foreignQuestion.id).toBe(foreignQuestionId);

    try {
      const first = await adapter.createMarketFromQuestion(
        { ...foreignQuestion, status: 'active' as const },
        7777,
        { initialYesProbability: 0.5 }
      );
      // A second creation attempt for the same question collides on the
      // market insert; the adapter returns the pre-existing market
      // instead of inserting a new one (liquidity is not re-seeded).
      const second = await adapter.createMarketFromQuestion(
        { ...foreignQuestion, status: 'active' as const },
        10000,
        { initialYesProbability: 0.5 }
      );
      expect(second.id).toBe(first.id);
      expect(Number(second.yesShares)).toBe(Number(first.yesShares));
      expect(Number(second.noShares)).toBe(Number(first.noShares));

      // Fixture-style registration, the same rule createMarket applies:
      // the market existed before the call, so nothing is registered…
      const registry: string[] = [];
      const existing = await db
        .select({ id: markets.id })
        .from(markets)
        .where(eq(markets.id, foreignQuestionId));
      if (existing.length === 0) registry.push(second.id);
      expect(registry).toHaveLength(0);

      // …and owned-scoped cleanup therefore leaves the market in place.
      if (registry.length > 0) {
        await db.delete(markets).where(inArray(markets.id, registry));
      }
      const [stillThere] = await db
        .select()
        .from(markets)
        .where(eq(markets.id, foreignQuestionId));
      expect(stillThere?.id).toBe(foreignQuestionId);
    } finally {
      // Leave no trace of the foreign rows either.
      await db.delete(markets).where(eq(markets.id, foreignQuestionId));
      await db.delete(questions).where(eq(questions.id, foreignQuestionId));
    }
  });
});

/**
 * Markets Tick: manual resolution review hold
 *
 * A question whose proof needs admin review (requiresManualReview, review
 * pending), or whose proof an admin rejected and postponed, must stay active
 * and unpaid through a real markets-tick run. An approved review still pays.
 * Real database and the real cron handler; no LLM call is needed because the
 * proof is already stored.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import {
  balanceTransactions,
  db,
  eq,
  games,
  markets,
  notifications,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  questions,
  sql,
  timeframedMarkets,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { FEE_CONFIG, withPredictionSettlement } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { getAdminToken } from './helpers';

setDefaultTimeout(120000);

let gameId: string | null = null;
type Fixture = {
  questionId: string;
  timeframedId: string;
  userId: string;
  payout: number;
};
const created: Fixture[] = [];
const originalCronSecret = process.env.CRON_SECRET;
const originalGameStart = process.env.GAME_START;
const originalRelay = process.env.REDIRECT_CRON_STAGING;

beforeAll(async () => {
  process.env.CRON_SECRET = 'review-hold-integration';
  process.env.GAME_START = 'true';
  process.env.REDIRECT_CRON_STAGING = 'false';
  await db.execute(sql`SELECT 1`);
  const [running] = await db
    .select()
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);
  if (running && !running.isRunning)
    throw new Error(
      'This whole-cron test requires a disposable database with a running game or no game.'
    );
  if (!running) {
    gameId = await generateSnowflakeId();
    await db.insert(games).values({
      id: gameId,
      isContinuous: true,
      isRunning: true,
      currentDay: 1,
      updatedAt: new Date(),
    });
  }
});

afterAll(async () => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
  if (originalGameStart === undefined) delete process.env.GAME_START;
  else process.env.GAME_START = originalGameStart;
  if (originalRelay === undefined) delete process.env.REDIRECT_CRON_STAGING;
  else process.env.REDIRECT_CRON_STAGING = originalRelay;
  await Bun.sleep(100);
  for (const c of created) {
    for (const table of [
      notifications,
      pointsTransactions,
      balanceTransactions,
      tradingFees,
      tradingFeeOutbox,
      positions,
    ])
      await db.delete(table).where(eq(table.userId, c.userId));
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, c.questionId));
    await db
      .delete(timeframedMarkets)
      .where(eq(timeframedMarkets.id, c.timeframedId));
    await db.delete(markets).where(eq(markets.id, c.questionId));
    await db.delete(questions).where(eq(questions.id, c.questionId));
    await db.delete(users).where(eq(users.id, c.userId));
  }
  if (gameId) await db.delete(games).where(eq(games.id, gameId));
});

type Review = 'pending' | 'unset' | 'rejected' | 'approved';

async function seedEndedMarket(review: Review) {
  const now = Date.now();
  const questionId = await generateSnowflakeId();
  const timeframedId = await generateSnowflakeId();
  const userId = await generateSnowflakeId();
  const fixture = { questionId, timeframedId, userId, payout: 0 };
  created.push(fixture);
  await db.insert(users).values({
    id: userId,
    username: `review-hold-${userId}`,
    virtualBalance: '500',
    totalDeposited: '500',
    updatedAt: new Date(),
  });
  const [max] = await db
    .select({ max: sql<number>`COALESCE(MAX("questionNumber"), 0)` })
    .from(questions);
  const text = `Integration test: review hold ${review} ${questionId}`;
  await db.insert(questions).values({
    id: questionId,
    questionNumber: Number(max?.max ?? 0) + 1,
    text,
    scenarioId: 1,
    outcome: true,
    rank: 1,
    createdDate: new Date(now - 3_600_000),
    status: 'active',
    updatedAt: new Date(),
    resolutionConfidence: 0.3,
    // Reject clears the proof and the review flag and postpones resolution by 24 h
    // (admin/resolutions/[id]); pending and approved keep the stored proof.
    ...(review === 'rejected'
      ? {
          requiresManualReview: false,
          resolutionReviewStatus: 'rejected',
          resolutionDate: new Date(now + 24 * 3_600_000),
        }
      : {
          requiresManualReview: true,
          resolutionReviewStatus: review === 'unset' ? null : review,
          resolutionDate: new Date(now - 60_000),
          resolutionDescription: 'Low-confidence proof',
          resolutionProofUrl: 'https://example.invalid/proof',
        }),
  });
  await db.insert(markets).values({
    id: questionId,
    question: text,
    liquidity: '10000',
    yesShares: '5000',
    noShares: '5000',
    endDate: new Date(now + 3_600_000),
    updatedAt: new Date(),
  });
  const bought = await withPredictionSettlement(
    questionId,
    { userId },
    (service) =>
      service.buy({ userId, marketId: questionId, side: 'yes', amount: 100 }),
    {
      fees: {
        tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
        platformShare: FEE_CONFIG.PLATFORM_SHARE,
        referrerShare: FEE_CONFIG.REFERRER_SHARE,
        minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
      },
    }
  );
  const [held] = await db
    .select()
    .from(positions)
    .where(eq(positions.id, bought.positionId));
  expect(held).toBeDefined();
  fixture.payout = Math.floor(Number(held!.shares) * 100) / 100;
  await db
    .update(markets)
    .set({ endDate: new Date(now - 60_000) })
    .where(eq(markets.id, questionId));
  await db.insert(timeframedMarkets).values({
    id: timeframedId,
    questionId,
    timeframe: 'intraday',
    startTime: new Date(now - 3_600_000),
    endTime: new Date(now - 60_000),
    isActive: true,
    isResolved: false,
    arcStateEnteredAt: new Date(now - 3_600_000),
  });
  return fixture;
}

async function stateOf(ids: Fixture) {
  const [q] = await db
    .select({ status: questions.status })
    .from(questions)
    .where(eq(questions.id, ids.questionId));
  const [m] = await db
    .select({ resolved: markets.resolved })
    .from(markets)
    .where(eq(markets.id, ids.questionId));
  const [t] = await db
    .select({ isActive: timeframedMarkets.isActive })
    .from(timeframedMarkets)
    .where(eq(timeframedMarkets.id, ids.timeframedId));
  const [user] = await db.select().from(users).where(eq(users.id, ids.userId));
  const ledger = await db
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, ids.userId));
  return {
    balance: Number(user?.virtualBalance),
    payouts: ledger
      .filter((row) => row.type === 'pred_resolve')
      .map((row) => Number(row.amount)),
    status: q?.status,
    paid: m?.resolved,
    timeframedActive: t?.isActive,
  };
}

async function runTick() {
  const { POST } = await import('@/app/api/cron/markets-tick/route');
  const res = await POST(
    new NextRequest('http://localhost/api/cron/markets-tick', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    })
  );
  expect(res.status).toBe(200);
  expect((await res.json()).skipped).not.toBe(true);
}

async function decide(fixture: Fixture, action: 'approve' | 'reject') {
  const { POST } = await import('@/app/api/admin/resolutions/[id]/route');
  const token = getAdminToken();
  if (!token) throw new Error('Integration admin token is required');
  const response = await POST(
    new NextRequest(
      `http://localhost/api/admin/resolutions/${fixture.questionId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-dev-admin-token': token,
        },
        body: JSON.stringify({ action }),
      }
    ),
    { params: Promise.resolve({ id: fixture.questionId }) }
  );
  expect(response.status).toBe(200);
}

function heldState() {
  return {
    balance: 400,
    payouts: [],
    status: 'active',
    paid: false,
    timeframedActive: true,
  };
}
function paidState(fixture: Fixture) {
  return {
    balance: 400 + fixture.payout,
    payouts: [fixture.payout],
    status: 'resolved',
    paid: true,
    timeframedActive: false,
  };
}

describe('markets-tick manual resolution review', () => {
  test('funded reviews stay held across ticks until approval; rejection postpones payment', async () => {
    const pending = await seedEndedMarket('pending');
    const unset = await seedEndedMarket('unset');
    const rejected = await seedEndedMarket('rejected');
    const approved = await seedEndedMarket('approved');
    for (let i = 0; i < 2; i++) {
      await runTick();
      for (const fixture of [pending, unset, rejected])
        expect(await stateOf(fixture)).toEqual(heldState());
      expect(await stateOf(approved)).toEqual(paidState(approved));
    }
    await decide(pending, 'approve');
    await decide(unset, 'reject');
    for (let i = 0; i < 2; i++) {
      await runTick();
      for (const fixture of [unset, rejected])
        expect(await stateOf(fixture)).toEqual(heldState());
      for (const fixture of [pending, approved])
        expect(await stateOf(fixture)).toEqual(paidState(fixture));
    }
  });
});

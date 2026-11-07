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
  db,
  eq,
  games,
  markets,
  questions,
  sql,
  timeframedMarkets,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

setDefaultTimeout(120000);

let dbAvailable = false;
let gameId: string | null = null;
const created: { questionId: string; timeframedId: string }[] = [];
const originalCronSecret = process.env.CRON_SECRET;

beforeAll(async () => {
  process.env.CRON_SECRET = 'review-hold-integration';
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  const [running] = await db.execute(
    sql`SELECT id FROM "Game" WHERE "isContinuous" = true AND "isRunning" = true LIMIT 1`
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
  if (!dbAvailable) return;
  for (const c of created) {
    await db
      .delete(timeframedMarkets)
      .where(eq(timeframedMarkets.id, c.timeframedId));
    await db.delete(markets).where(eq(markets.id, c.questionId));
    await db.delete(questions).where(eq(questions.id, c.questionId));
  }
  if (gameId) await db.delete(games).where(eq(games.id, gameId));
});

type Review = 'pending' | 'rejected' | 'approved';

async function seedEndedMarket(review: Review) {
  const now = Date.now();
  const questionId = await generateSnowflakeId();
  const timeframedId = await generateSnowflakeId();
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
          resolutionReviewStatus: review,
          resolutionDate: new Date(now - 60_000),
          resolutionDescription: 'Low-confidence proof',
          resolutionProofUrl: 'https://example.invalid/proof',
        }),
  });
  await db.insert(markets).values({
    id: questionId,
    question: text,
    liquidity: '1000',
    endDate: new Date(now - 60_000),
    updatedAt: new Date(),
  });
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
  created.push({ questionId, timeframedId });
  return { questionId, timeframedId };
}

async function stateOf(ids: { questionId: string; timeframedId: string }) {
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
  return {
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
}

describe('markets-tick manual resolution review', () => {
  test('a pending review and a rejected review stay active and unpaid; an approved review pays', async () => {
    if (!dbAvailable) {
      console.log('Skipping - database not available');
      return;
    }
    const pending = await seedEndedMarket('pending');
    const rejected = await seedEndedMarket('rejected');
    const approved = await seedEndedMarket('approved');

    await runTick();

    expect(await stateOf(pending)).toEqual({
      status: 'active',
      paid: false,
      timeframedActive: true,
    });
    expect(await stateOf(rejected)).toEqual({
      status: 'active',
      paid: false,
      timeframedActive: true,
    });
    expect(await stateOf(approved)).toEqual({
      status: 'resolved',
      paid: true,
      timeframedActive: false,
    });
  });
});

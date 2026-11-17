import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  dbWrite,
  eq,
  lte,
  markets,
  positions,
  questions,
  timeframedMarkets,
  users,
} from '@feed/db';
import { resolveQuestionPayouts } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/markets/[marketId]/route';

/**
 * Admin extend vs cron resolution timing — through the REAL route handler.
 *
 * POST /api/admin/markets/[marketId] (action 'extend') used to update only
 * markets.endDate while the markets-tick cron resolves on
 * questions.resolutionDate, so an extended market still resolved on its
 * original date while the UI showed the later date.
 *
 * An earlier version of this test called a helper that mirrored the route's
 * writes, so reverting the route did not fail the test — it was not
 * regression evidence for the route. This version calls the real POST
 * handler (with the test-DID admin auth the admin-email suite uses), so
 * reverting the route patch alone must fail it; tests (a) and (b) fail
 * against the base route.
 *
 * Auth: steward:test:<adminId> with ALLOW_TEST_PRIVY_DID_AUTH=true.
 * The fixture admin user carries isAdmin so requireAdmin passes.
 */

const createdUsers: string[] = [];
const createdMarkets: string[] = [];
const createdQuestions: string[] = [];
const createdTimeframes: string[] = [];

let adminId = '';

const previousTestAuth = process.env.ALLOW_TEST_PRIVY_DID_AUTH;

function uniqueQuestionNumber() {
  return 900_000 + Math.floor(Math.random() * 9_000);
}

/**
 * Exact copy of the maturity predicate from
 * apps/web/src/app/api/cron/markets-tick/route.ts
 * getMarketsReadyForResolution: a question is picked for resolution when it
 * is active and its QUESTION resolutionDate has passed. The market row's own
 * endDate plays no part in the decision.
 */
async function pickMatureMarkets(now: Date) {
  return dbWrite
    .select({
      id: questions.id,
      questionNumber: questions.questionNumber,
      resolutionDate: questions.resolutionDate,
    })
    .from(questions)
    .leftJoin(timeframedMarkets, eq(timeframedMarkets.questionId, questions.id))
    .where(
      and(eq(questions.status, 'active'), lte(questions.resolutionDate, now))
    );
}

async function fixture() {
  const userId = await generateSnowflakeId();
  const questionId = await generateSnowflakeId();
  const questionNumber = uniqueQuestionNumber();
  const timeframeId = await generateSnowflakeId();
  const originalEnd = new Date(Date.now() + 60 * 60 * 1000); // +1h
  const now = new Date();
  createdUsers.push(userId);
  createdMarkets.push(questionId);
  createdQuestions.push(questionId);
  createdTimeframes.push(timeframeId);

  await dbWrite.insert(users).values({
    id: userId,
    username: `extend-${userId}`,
    profileComplete: true,
    virtualBalance: '1000',
    totalDeposited: '1000',
    updatedAt: now,
  });
  await dbWrite.insert(questions).values({
    id: questionId,
    questionNumber,
    text: 'Admin extend resolution regression',
    scenarioId: 1,
    outcome: true, // YES wins
    rank: 1,
    resolutionDate: originalEnd,
    status: 'active',
    updatedAt: now,
  });
  await dbWrite.insert(markets).values({
    id: questionId,
    question: 'Admin extend resolution regression',
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: originalEnd,
    updatedAt: now,
  });
  await dbWrite.insert(timeframedMarkets).values({
    id: timeframeId,
    questionId,
    timeframe: '1d',
    startTime: now,
    endTime: originalEnd,
    arcStateEnteredAt: now,
  });
  await dbWrite.insert(positions).values({
    id: await generateSnowflakeId(),
    userId,
    marketId: questionId,
    side: true, // YES
    shares: '10',
    avgPrice: '0.5',
    cashCostBasis: '5',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return { userId, questionId, questionNumber, originalEnd };
}

/** Call the real extend handler for a market. Returns the raw Response. */
async function callExtend(marketId: string, newEnd: Date) {
  return POST(
    new NextRequest(`http://localhost/api/admin/markets/${marketId}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer steward:test:${adminId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'extend',
        newEndDate: newEnd.toISOString(),
      }),
    }),
    { params: Promise.resolve({ marketId }) }
  );
}

async function readMarket(marketId: string) {
  const [row] = await dbWrite
    .select()
    .from(markets)
    .where(eq(markets.id, marketId));
  return row;
}

async function readQuestion(questionId: string) {
  const [row] = await dbWrite
    .select()
    .from(questions)
    .where(eq(questions.id, questionId));
  return row;
}

async function readTimeframe(questionId: string) {
  const [row] = await dbWrite
    .select()
    .from(timeframedMarkets)
    .where(eq(timeframedMarkets.questionId, questionId));
  return row;
}

async function userBalance(userId: string) {
  const [row] = await dbWrite.select().from(users).where(eq(users.id, userId));
  return Number(row?.virtualBalance ?? 0);
}

beforeAll(async () => {
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'true';
  adminId = await generateSnowflakeId();
  await dbWrite.insert(users).values({
    id: adminId,
    username: `extend-admin-${adminId}`,
    isAdmin: true,
    updatedAt: new Date(),
  });
  createdUsers.push(adminId);
});

afterAll(async () => {
  try {
    if (createdTimeframes.length) {
      for (const timeframeId of createdTimeframes) {
        await dbWrite
          .delete(timeframedMarkets)
          .where(eq(timeframedMarkets.id, timeframeId));
      }
    }
    for (const userId of createdUsers) {
      await dbWrite.delete(positions).where(eq(positions.userId, userId));
    }
    for (const marketId of createdMarkets) {
      await dbWrite.delete(positions).where(eq(positions.marketId, marketId));
      await dbWrite.delete(markets).where(eq(markets.id, marketId));
    }
    for (const questionId of createdQuestions) {
      await dbWrite.delete(questions).where(eq(questions.id, questionId));
    }
    for (const userId of createdUsers) {
      await dbWrite.delete(users).where(eq(users.id, userId));
    }
  } finally {
    if (previousTestAuth === undefined) {
      delete process.env.ALLOW_TEST_PRIVY_DID_AUTH;
    } else {
      process.env.ALLOW_TEST_PRIVY_DID_AUTH = previousTestAuth;
    }
  }
});

describe('admin extend vs cron resolution timing (real route handler)', () => {
  it('(a) extend moves the market, question and timeframe dates together', async () => {
    const { questionId, originalEnd } = await fixture();
    const extended = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3d

    const response = await callExtend(questionId, extended);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success?: boolean;
      newEndDate?: string;
    };
    expect(body.success).toBe(true);
    expect(body.newEndDate).toBe(extended.toISOString());

    // All three clocks move to the same date — the market row, the
    // question the cron reads, and the timeframe row.
    const market = await readMarket(questionId);
    expect(market?.endDate.getTime()).toBe(extended.getTime());
    const question = await readQuestion(questionId);
    expect(question?.resolutionDate.getTime()).toBe(extended.getTime());
    const timeframe = await readTimeframe(questionId);
    expect(timeframe?.endTime.getTime()).toBe(extended.getTime());

    // The fixture dates moved; the original end is gone from all three.
    expect(market?.endDate.getTime()).not.toBe(originalEnd.getTime());
  });

  it('(b) an extended market is not resolved on the original date', async () => {
    const { userId, questionId, questionNumber, originalEnd } = await fixture();
    const extended = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3d

    const response = await callExtend(questionId, extended);
    expect(response.status).toBe(200);

    // Time passes the ORIGINAL end date, but the market now ends in 3 days.
    const afterOriginal = new Date(originalEnd.getTime() + 60 * 60 * 1000);
    const mature = await pickMatureMarkets(afterOriginal);
    expect(mature.some((m) => m.questionNumber === questionNumber)).toBe(false);

    // Even if the cron ran, nothing may settle while the market is extended.
    // (On base this runs because the pick above returns the question; the
    // assertions below then show the loss: resolved + paid early.)
    if (mature.some((m) => m.questionNumber === questionNumber)) {
      await resolveQuestionPayouts(questionNumber);
    }
    const market = await readMarket(questionId);
    expect(market?.resolved).toBe(false);
    expect(await userBalance(userId)).toBe(1000);
  });

  it('(d) a non-active question fails the extend instead of splitting the dates', async () => {
    const { questionId, originalEnd } = await fixture();
    // The split state the extend must never create silently: the question
    // is no longer active while the market is still unresolved.
    await dbWrite
      .update(questions)
      .set({ status: 'resolved' })
      .where(eq(questions.id, questionId));
    const extended = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // +3d

    const response = await callExtend(questionId, extended);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('MARKET_CONFLICT');

    // Nothing moved: the market, question and timeframe dates all stay
    // at the original end.
    const market = await readMarket(questionId);
    expect(market?.endDate.getTime()).toBe(originalEnd.getTime());
    const question = await readQuestion(questionId);
    expect(question?.resolutionDate.getTime()).toBe(originalEnd.getTime());
    const timeframe = await readTimeframe(questionId);
    expect(timeframe?.endTime.getTime()).toBe(originalEnd.getTime());
  });

  it('(c) a CAS conflict leaves all three tables untouched', async () => {
    // The 409 branch needs a concurrent writer: the handler reads the
    // market row and then compare-and-sets on the end date it just read.
    // Two simultaneous extends with different targets race; the loser
    // gets 409 and must move nothing, so all three tables stay exactly
    // at the winner's dates. Simultaneous requests usually both read
    // before either writes, but a fully sequential interleave yields
    // 200+200/400 instead — retry with a fresh fixture until a real 409
    // is observed (bounded, so the test only passes on a genuine conflict).
    const day = 24 * 60 * 60 * 1000;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { questionId } = await fixture();
      const endA = new Date(Date.now() + 3 * day);
      const endB = new Date(Date.now() + 4 * day);
      const [resA, resB] = await Promise.all([
        callExtend(questionId, endA),
        callExtend(questionId, endB),
      ]);
      const statuses = [resA.status, resB.status];
      if (!(statuses.includes(200) && statuses.includes(409))) {
        continue;
      }
      const winnerEnd = resA.status === 200 ? endA : endB;
      const loserBody = (await (resA.status === 409 ? resA : resB).json()) as {
        error?: { code?: string };
      };
      expect(loserBody.error?.code).toBe('MARKET_CONFLICT');

      // The loser moved nothing: all three tables agree exactly with
      // the winner's single move — no partial or double application.
      const market = await readMarket(questionId);
      expect(market?.endDate.getTime()).toBe(winnerEnd.getTime());
      const question = await readQuestion(questionId);
      expect(question?.resolutionDate.getTime()).toBe(winnerEnd.getTime());
      const timeframe = await readTimeframe(questionId);
      expect(timeframe?.endTime.getTime()).toBe(winnerEnd.getTime());
      return;
    }
    throw new Error('CAS conflict (409) not observed in 5 attempts');
  });
});

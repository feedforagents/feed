/**
 * Game Service — Active Market Summaries Integration Test
 *
 * Evidence for the getActiveMarketSummaries fix (feedforagents/feed):
 * `GameService.getActiveMarketSummaries()` must exclude expired-but-
 * unresolved markets from the summaries it returns.
 *
 * Same defect class as PR #2102 (admin trading stats) and the
 * metrics-snapshot fix: the query counted every unresolved market as
 * active. This one is agent-facing: NPC context providers
 * (`packages/agents/src/plugins/feed/providers/npc-game-context.ts`)
 * build an NPC's trading context from these summaries, so an expired
 * market was presented to NPC agents as a market they could still trade
 * on — even though buys on it are refused (PRD §8.1/§9.2: active means
 * open for trading).
 *
 * This test calls the service directly against a real Postgres database:
 *
 * - With the fix: seeding one live linked market and one expired-but-
 *   unresolved linked market returns only the live one.
 * - Without the fix: the same seed returns both, because the expired
 *   market is still listed.
 *
 * The before/after pair is selected with GAME_SERVICE_EXPECT_BUGGY=1
 * for the pre-fix run; the default run asserts the fixed behavior. Each
 * run logs one `[evidence]` line with its correlation ID and the
 * resulting summary IDs.
 *
 * Run with: bun run test:integration -- packages/testing/integration/game-service-active-markets.integration.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, eq, inArray, markets, questions } from '@feed/db';
import { gameService } from '../../engine/src/game-service';

const prefix = `game-service-active-${randomUUID()}`;
const questionIds: string[] = [];
const marketIds: string[] = [];
let questionNumber = 1_700_000_000 + Math.floor(Math.random() * 100_000_000);

async function createLinkedMarket(suffix: string, endDate: Date) {
  const questionId = `${prefix}-${suffix}-q`;
  const marketId = `${prefix}-${suffix}-m`;
  questionIds.push(questionId);
  marketIds.push(marketId);
  await db.insert(questions).values({
    id: questionId,
    questionNumber: questionNumber++,
    text: `slop-game-service Test: ${suffix} market`,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    resolutionDate: endDate,
    updatedAt: new Date(),
  });
  await db.insert(markets).values({
    id: marketId,
    question: `slop-game-service Test: ${suffix} market`,
    liquidity: '1000',
    endDate,
    updatedAt: new Date(),
  });
  await db
    .update(questions)
    .set({ marketId })
    .where(eq(questions.id, questionId));
  return { questionId, marketId };
}

afterAll(async () => {
  if (questionIds.length)
    await db.delete(questions).where(inArray(questions.id, questionIds));
  if (marketIds.length)
    await db.delete(markets).where(inArray(markets.id, marketIds));
});

describe('GameService — active market summaries exclude expired markets', () => {
  test('expired-but-unresolved markets are excluded from NPC summaries', async () => {
    const expectBuggy = process.env.GAME_SERVICE_EXPECT_BUGGY === '1';
    const correlationId = randomUUID();
    const now = Date.now();

    const live = await createLinkedMarket(
      'live',
      new Date(now + 7 * 24 * 60 * 60 * 1000)
    );
    const expired = await createLinkedMarket(
      'expired',
      new Date(now - 60 * 60 * 1000)
    );

    const summaries = await gameService.getActiveMarketSummaries(10000);
    const ids = summaries.map((summary) => summary.id);
    const foundLive = ids.includes(live.marketId);
    const foundExpired = ids.includes(expired.marketId);
    const liveSummary = summaries.find(
      (summary) => summary.id === live.marketId
    );
    console.log(
      `[evidence] correlationId=${correlationId} summariesReturned=${summaries.length} foundLive=${foundLive} foundExpired=${foundExpired} liveSummary=${JSON.stringify(liveSummary)}`
    );

    expect(foundLive).toBe(true);
    expect(liveSummary).toEqual({
      id: live.marketId,
      questionId: live.questionId,
      question: `slop-game-service Test: live market`,
    });
    // With the fix the expired market is excluded; without it, it is listed.
    expect(foundExpired).toBe(expectBuggy);
  });
});

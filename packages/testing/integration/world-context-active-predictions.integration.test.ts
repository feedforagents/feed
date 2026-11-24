/**
 * World Context — Active Predictions Integration Test
 *
 * Evidence for the generateActivePredictions fix (feedforagents/feed):
 * `generateActivePredictions()` must exclude expired-but-unresolved
 * questions from the "Active Questions" string it builds for agent
 * prompts.
 *
 * Same defect class as PR #2102 (admin trading stats), the
 * metrics-snapshot fix, the game-service fix, and the world-context
 * markets fix: the query relied on a stale-status flag alone. A
 * question past its resolution date but not yet resolved keeps
 * `status = 'active'` — the codebase's own `expiredMarkets()` helper
 * (`packages/db/src/prediction-resolution-work.ts`) defines exactly
 * that population as pending resolutions — so the base query listed
 * them with a negative countdown ("resolves in -1d").
 *
 * This test calls the function directly against a real Postgres
 * database:
 *
 * - With the fix: seeding one live question and one expired-but-
 *   unresolved question (both status 'active') shows only the live
 *   question in the output string.
 * - Without the fix: the same seed shows both, because the expired
 *   question is still listed.
 *
 * The before/after pair is selected with WORLD_PREDICTIONS_EXPECT_BUGGY=1
 * for the pre-fix run; the default run asserts the fixed behavior. Each
 * run logs one `[evidence]` line with its correlation ID and the
 * resulting flags.
 *
 * Run with: bun run test:integration -- packages/testing/integration/world-context-active-predictions.integration.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, inArray, questions } from '@feed/db';
import { generateActivePredictions } from '../../engine/src/prompts/world-context';

const prefix = `world-predictions-${randomUUID()}`;
const questionIds: string[] = [];
let questionNumber = 1_700_000_000 + Math.floor(Math.random() * 100_000_000);

async function createQuestion(suffix: string, resolutionDate: Date) {
  const id = `${prefix}-${suffix}`;
  questionIds.push(id);
  const [question] = await db
    .insert(questions)
    .values({
      id,
      questionNumber: questionNumber++,
      text: `slop-world-predictions Test: ${suffix} question`,
      scenarioId: 1,
      outcome: false,
      rank: 1,
      resolutionDate,
      updatedAt: new Date(),
    })
    .returning();
  if (!question) throw new Error('Test question was not created');
  return question;
}

afterAll(async () => {
  if (questionIds.length)
    await db.delete(questions).where(inArray(questions.id, questionIds));
});

describe('World Context — active predictions exclude expired questions', () => {
  test('expired-but-unresolved questions are excluded from agent world context', async () => {
    const expectBuggy = process.env.WORLD_PREDICTIONS_EXPECT_BUGGY === '1';
    const correlationId = randomUUID();
    const now = Date.now();

    await createQuestion('live', new Date(now + 7 * 24 * 60 * 60 * 1000));
    await createQuestion('expired', new Date(now - 60 * 60 * 1000));

    const output = await generateActivePredictions();
    const foundLive = output.includes(
      'slop-world-predictions Test: live question'
    );
    const foundExpired = output.includes(
      'slop-world-predictions Test: expired question'
    );
    console.log(
      `[evidence] correlationId=${correlationId} foundLive=${foundLive} foundExpired=${foundExpired} output=${output.slice(0, 400)}`
    );

    expect(foundLive).toBe(true);
    // With the fix the expired question is excluded; without it, it is listed.
    expect(foundExpired).toBe(expectBuggy);
  });
});

/**
 * Reputation: an agent with no intel feedback must not be scored with the
 * placeholder intel score.
 *
 * `agentPerformanceMetrics.averageIntelScore` defaults to 50 and is only
 * updated when intel feedback arrives, so every user with
 * `intelFeedbackCount = 0` carries the placeholder 50. `recalculateReputation`
 * passed that placeholder into `calculateReputationScore`, whose own default
 * (`intelScore = averageFeedbackScore`) says no intel data means "use the
 * general feedback score". The placeholder therefore dragged the feedback
 * component toward 50 for everyone without intel feedback — e.g. a user with
 * averageFeedbackScore 70 scored 39.6 (LOW) instead of 42.0 (MEDIUM).
 *
 * Runs the real recalculation against a real database. Nothing is mocked.
 *
 * Run with:
 *   bun test packages/testing/integration/reputation-intel-fallback.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { agentPerformanceMetrics, db, eq, users } from '@feed/db';
import { recalculateReputation } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const noIntelUserId = await generateSnowflakeId();
const withIntelUserId = await generateSnowflakeId();

async function seedUser(userId: string) {
  await db.insert(users).values({
    id: userId,
    username: `reputation-intel-${userId}`,
    isTest: true,
    updatedAt: new Date(),
  });
}

async function seedMetrics(
  userId: string,
  intelFeedbackCount: number,
  averageIntelScore: number
) {
  await db.insert(agentPerformanceMetrics).values({
    id: await generateSnowflakeId(),
    userId,
    normalizedPnL: 0.5,
    gamesPlayed: 0,
    winRate: 0,
    totalFeedbackCount: 1,
    averageFeedbackScore: 70,
    intelFeedbackCount,
    averageIntelScore,
    reputationScore: 70,
    trustLevel: 'UNRATED',
    updatedAt: new Date(),
  });
}

describe('reputation intel-score fallback', () => {
  afterAll(async () => {
    await db
      .delete(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, noIntelUserId));
    await db
      .delete(agentPerformanceMetrics)
      .where(eq(agentPerformanceMetrics.userId, withIntelUserId));
    await db.delete(users).where(eq(users.id, noIntelUserId));
    await db.delete(users).where(eq(users.id, withIntelUserId));
  });

  test('no intel feedback: reputation uses the general feedback score, not the 50 placeholder', async () => {
    await seedUser(noIntelUserId);
    await seedMetrics(noIntelUserId, 0, 50);

    const result = await recalculateReputation(noIntelUserId);
    expect(result).not.toBeNull();
    // Feedback component: 70 * 0.7 + 70 * 0.3 = 70 (not 70 * 0.7 + 50 * 0.3 = 64).
    // Score: 35 * 0.4 + 70 * 0.4 + 0 * 0.2 = 42.0 (before fix: 39.6, LOW).
    expect(result?.reputationScore).toBeCloseTo(42, 1);
    expect(result?.trustLevel).toBe('MEDIUM');
  });

  test('real intel feedback still uses the actual intel score', async () => {
    await seedUser(withIntelUserId);
    await seedMetrics(withIntelUserId, 2, 90);

    const result = await recalculateReputation(withIntelUserId);
    expect(result).not.toBeNull();
    // Feedback component: 70 * 0.7 + 90 * 0.3 = 76.
    // Score: 35 * 0.4 + 76 * 0.4 + 0 * 0.2 = 44.4.
    expect(result?.reputationScore).toBeCloseTo(44.4, 1);
    expect(result?.trustLevel).toBe('MEDIUM');
  });
});

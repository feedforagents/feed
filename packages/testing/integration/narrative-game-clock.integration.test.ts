/** Persisted schedule coverage for PRD §9.2/§9.3 and MVP phase 0.
 * Calls the real arc processor and database. A recent real lastEventAt keeps
 * the separate legacy random-event fallback in cooldown, without mocking it.
 * These tests do not exercise LLM article generation or a complete NPC tick.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import {
  arcStates,
  db,
  eq,
  inArray,
  questionArcPlans,
  questions,
  worldEvents,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { processArcTick } from '../../engine/src/services/narrative-event-processor';
import { getGameDayNumber } from '../../engine/src/utils/date-utils';

const hour = 60 * 60 * 1000;
const ownedQuestionIds: string[] = [];
const ownedNumbers: number[] = [];

async function fixture(baseDay: number, jitterHours: number) {
  const questionId = await generateSnowflakeId();
  const questionNumber = -randomInt(1, 2_000_000_000);
  const now = new Date();
  await db.insert(questions).values({
    id: questionId,
    questionNumber,
    text: `Will synthetic clock fixture ${questionId} resolve?`,
    scenarioId: 1,
    outcome: true,
    rank: 1,
    resolutionDate: new Date(now.getTime() + 7 * 24 * hour),
    updatedAt: now,
  });
  ownedQuestionIds.push(questionId);
  ownedNumbers.push(questionNumber);
  const arcId = await generateSnowflakeId();
  await db.insert(arcStates).values({
    id: arcId,
    questionId,
    currentState: 'setup',
    stateEnteredAt: now,
    lastEventAt: now,
    updatedAt: now,
  });
  await db.insert(questionArcPlans).values({
    id: await generateSnowflakeId(),
    questionId,
    uncertaintyPeakDay: 8,
    clarityOnsetDay: 17,
    verificationDay: 27,
    phaseRatios: { early: 0.4, middle: 0.6, late: 0.8, climax: 1 },
    eventSchedule: [
      {
        baseDay,
        jitterHours,
        eventType: 'rumor',
        description: 'Synthetic scheduled clock event',
        signalDirection: 'YES',
        fired: false,
      },
    ],
  });
  return { questionId, questionNumber, arcId };
}

afterAll(async () => {
  if (ownedNumbers.length) {
    await db
      .delete(worldEvents)
      .where(inArray(worldEvents.relatedQuestion, ownedNumbers));
  }
  if (ownedQuestionIds.length) {
    await db
      .delete(arcStates)
      .where(inArray(arcStates.questionId, ownedQuestionIds));
    await db
      .delete(questionArcPlans)
      .where(inArray(questionArcPlans.questionId, ownedQuestionIds));
    await db.delete(questions).where(inArray(questions.id, ownedQuestionIds));
  }
});

describe('persisted narrative schedule uses elapsed game time', () => {
  for (const scenario of [
    {
      name: 'non-midnight game start',
      baseDay: 1,
      jitterHours: 8,
      beforeHours: 1.5,
      dueHours: 8,
      expectedDay: 1,
    },
    {
      name: 'negative jitter on the previous game day',
      baseDay: 2,
      jitterHours: -4,
      beforeHours: 19,
      dueHours: 20,
      expectedDay: 1,
    },
    {
      name: 'overdue event after a game-day rollover',
      baseDay: 1,
      jitterHours: 23,
      beforeHours: 22,
      dueHours: 24,
      expectedDay: 2,
    },
  ]) {
    test(scenario.name, async () => {
      const f = await fixture(scenario.baseDay, scenario.jitterHours);
      const gameStartedAt = new Date('2026-11-01T15:17:00.000Z');
      const before = new Date(
        gameStartedAt.getTime() + scenario.beforeHours * hour
      );
      const due = new Date(gameStartedAt.getTime() + scenario.dueHours * hour);
      const events = () =>
        db
          .select()
          .from(worldEvents)
          .where(eq(worldEvents.relatedQuestion, f.questionNumber));
      const early = await processArcTick(
        f.arcId,
        getGameDayNumber(gameStartedAt, before),
        null,
        { gameStartedAt, now: before }
      );
      expect(early.eventGenerated).toBe(false);
      expect(await events()).toHaveLength(0);
      const first = await processArcTick(
        f.arcId,
        getGameDayNumber(gameStartedAt, due),
        null,
        { gameStartedAt, now: due }
      );
      expect(first.eventGenerated).toBe(true);
      const created = await events();
      expect(created).toHaveLength(1);
      expect(created[0]?.dayNumber).toBe(scenario.expectedDay);
      expect(created[0]?.pointsToward).toBe('YES');
      const [plan] = await db
        .select()
        .from(questionArcPlans)
        .where(eq(questionArcPlans.questionId, f.questionId));
      expect(plan?.eventSchedule?.[0]?.fired).toBe(true);
      const repeated = await processArcTick(
        f.arcId,
        getGameDayNumber(gameStartedAt, due),
        null,
        { gameStartedAt, now: due }
      );
      expect(repeated.eventGenerated).toBe(false);
      expect(await events()).toHaveLength(1);
      const [arc] = await db
        .select()
        .from(arcStates)
        .where(eq(arcStates.id, f.arcId));
      expect(arc?.eventsGenerated).toBe(1);
    });
  }
});

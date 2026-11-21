import { afterAll, describe, expect, test } from 'bun:test';
import { PredictionDbAdapter } from '@feed/core/markets/prediction';
import { db, eq, inArray, markets, questions } from '@feed/db';
import { NextRequest } from 'next/server';
import { GET as detailGET } from '../../../apps/web/src/app/api/markets/predictions/[id]/route';
import { GET as listGET } from '../../../apps/web/src/app/api/markets/predictions/route';

/**
 * Regression: the terminal renders each prediction row's subtitle from the
 * market's `scenario`, and the web type declares it a required field of the
 * API payload — but the value lives on the market's question
 * (questions.scenarioId) and no layer carried it, so every row rendered
 * "Scenario undefined". The scenario must flow question → adapter record →
 * list/detail payloads unchanged.
 */

type QuestionInsert = typeof questions.$inferInsert;
type MarketInsert = typeof markets.$inferInsert;

/**
 * Tracks only rows whose writes actually succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway (for example
 * on an ID collision with a pre-existing row) can never delete data this
 * fixture did not create.
 *
 * The Market needs one extra rule: createMarketFromQuestion is
 * idempotent — on a market-ID conflict it returns the pre-existing
 * market instead of inserting one. A returned record is therefore not
 * proof of ownership; the market is registered only when no row with
 * that ID existed before the call.
 */
class OwnedFixtures {
  readonly questionIds: string[] = [];
  readonly marketIds: string[] = [];

  async insertQuestion(values: QuestionInsert) {
    const [row] = await db.insert(questions).values(values).returning();
    if (!row) throw new Error('question insert returned no row');
    this.questionIds.push(row.id);
    return row;
  }

  async insertMarket(values: MarketInsert): Promise<string> {
    const [row] = await db
      .insert(markets)
      .values(values)
      .returning({ id: markets.id });
    if (!row) throw new Error('market insert returned no row');
    this.marketIds.push(row.id);
    return row.id;
  }

  async marketExists(marketId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: markets.id })
      .from(markets)
      .where(eq(markets.id, marketId));
    return !!row;
  }

  ownCreatedMarket(marketId: string, existedBefore: boolean): void {
    if (!existedBefore && !this.marketIds.includes(marketId)) {
      this.marketIds.push(marketId);
    }
  }

  async cleanup(): Promise<void> {
    if (this.marketIds.length > 0) {
      await db.delete(markets).where(inArray(markets.id, this.marketIds));
    }
    if (this.questionIds.length > 0) {
      await db.delete(questions).where(inArray(questions.id, this.questionIds));
    }
    this.marketIds.length = 0;
    this.questionIds.length = 0;
  }
}

const fixtures = new OwnedFixtures();
const prefix = `prediction-scenario-${crypto.randomUUID()}`;
const questionId = `${prefix}-q1`;
const questionNumber = 1_900_000_000 + Math.floor(Math.random() * 90_000_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe('prediction market scenario wiring', () => {
  test('question scenarioId reaches the adapter records and both API payloads', async () => {
    const question = await fixtures.insertQuestion({
      id: questionId,
      questionNumber,
      text: 'Scenario wiring: will the number reach the terminal?',
      scenarioId: 7,
      outcome: false,
      rank: 1,
      resolutionDate: new Date(Date.now() + 86400000),
      updatedAt: new Date(),
    });

    const marketExistedBefore = await fixtures.marketExists(question.id);
    const adapter = new PredictionDbAdapter();
    const created = await adapter.createMarketFromQuestion(
      { ...question, status: 'active' as const },
      1000
    );
    fixtures.ownCreatedMarket(created.id, marketExistedBefore);
    expect(created.scenario).toBe(7);

    const listed = await adapter.listMarkets();
    expect(listed.find((m) => m.id === questionId)?.scenario).toBe(7);

    const byId = await adapter.getMarketById(questionId);
    expect(byId?.scenario).toBe(7);

    const listRes = await listGET(
      new NextRequest(
        'http://localhost/api/markets/predictions?limit=100&page=1'
      )
    );
    const listBody = (await listRes.json()) as {
      questions?: Array<Record<string, unknown>>;
    };
    const entry = listBody.questions?.find((q) => q.id === questionId);
    expect(entry?.scenario).toBe(7);
    // The exact expression the terminal row renders.
    expect(`Scenario ${entry?.scenario as number}`).toBe('Scenario 7');

    const detailRes = await detailGET(
      new NextRequest(`http://localhost/api/markets/predictions/${questionId}`),
      { params: Promise.resolve({ id: questionId }) }
    );
    const detailBody = (await detailRes.json()) as {
      market?: Record<string, unknown>;
    };
    expect(detailBody.market?.scenario).toBe(7);
  });
});

describe('fixture ownership', () => {
  test('cleanup preserves a pre-existing market returned by the idempotent create path', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const victimPrefix = `prediction-scenario-victim-${crypto.randomUUID()}`;
      const victimQuestionId = `${victimPrefix}-q1`;
      const victimQuestion = await victim.insertQuestion({
        id: victimQuestionId,
        questionNumber: 1_800_000_000 + Math.floor(Math.random() * 90_000_000),
        text: 'Pre-existing question',
        scenarioId: 3,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 86400000),
        updatedAt: new Date(),
      });
      await victim.insertMarket({
        id: victimQuestionId,
        question: victimQuestion.text,
        liquidity: '1000',
        endDate: victimQuestion.resolutionDate,
        updatedAt: new Date(),
      });

      // A question INSERT that collides with the pre-existing question
      // fails and registers no ownership.
      let questionCollisionFailed = false;
      try {
        await attempt.insertQuestion({
          id: victimQuestionId,
          questionNumber:
            1_700_000_000 + Math.floor(Math.random() * 90_000_000),
          text: 'Collision attempt',
          scenarioId: 1,
          outcome: false,
          rank: 1,
          resolutionDate: new Date(Date.now() + 86400000),
          updatedAt: new Date(),
        });
      } catch {
        questionCollisionFailed = true;
      }
      expect(questionCollisionFailed).toBe(true);
      expect(attempt.questionIds).toEqual([]);

      // The idempotent create returns the pre-existing market; the
      // attempt must not claim it.
      const existedBefore = await attempt.marketExists(victimQuestionId);
      expect(existedBefore).toBe(true);
      const adapter = new PredictionDbAdapter();
      const returned = await adapter.createMarketFromQuestion(
        { ...victimQuestion, status: 'active' as const },
        1000
      );
      expect(returned.id).toBe(victimQuestionId);
      attempt.ownCreatedMarket(returned.id, existedBefore);
      expect(attempt.marketIds).toEqual([]);

      await attempt.cleanup();

      // Both pre-existing rows survive the attempt's cleanup untouched.
      expect(await victim.marketExists(victimQuestionId)).toBe(true);
      const [survivingQuestion] = await db
        .select()
        .from(questions)
        .where(eq(questions.id, victimQuestionId));
      expect(survivingQuestion?.text).toBe('Pre-existing question');
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});

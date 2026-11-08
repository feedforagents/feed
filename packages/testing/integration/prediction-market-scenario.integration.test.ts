import { afterAll, describe, expect, test } from 'bun:test';
import { PredictionDbAdapter } from '@feed/core/markets/prediction';
import { db, inArray, markets, questions } from '@feed/db';
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
const prefix = `prediction-scenario-${crypto.randomUUID()}`;
const questionId = `${prefix}-q1`;
const questionNumber = 1_900_000_000 + Math.floor(Math.random() * 90_000_000);

afterAll(async () => {
  await db.delete(markets).where(inArray(markets.id, [questionId]));
  await db.delete(questions).where(inArray(questions.id, [questionId]));
});

describe('prediction market scenario wiring', () => {
  test('question scenarioId reaches the adapter records and both API payloads', async () => {
    const [question] = await db
      .insert(questions)
      .values({
        id: questionId,
        questionNumber,
        text: 'Scenario wiring: will the number reach the terminal?',
        scenarioId: 7,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(Date.now() + 86400000),
        updatedAt: new Date(),
      })
      .returning();
    if (!question) throw new Error('Test question was not created');

    const adapter = new PredictionDbAdapter();
    const created = await adapter.createMarketFromQuestion(
      { ...question, status: 'active' as const },
      1000
    );
    expect(created.scenario).toBe(7);

    const listed = await adapter.listMarkets();
    expect(listed.find((m) => m.id === questionId)?.scenario).toBe(7);

    const byId = await adapter.getMarketById(questionId);
    expect(byId?.scenario).toBe(7);

    const listRes = await listGET(
      new Request(
        'http://localhost/api/markets/predictions?limit=100&page=1'
      ) as never
    );
    const listBody = (await listRes.json()) as {
      questions?: Array<Record<string, unknown>>;
    };
    const entry = listBody.questions?.find((q) => q.id === questionId);
    expect(entry?.scenario).toBe(7);
    // The exact expression the terminal row renders.
    expect(`Scenario ${entry?.scenario as number}`).toBe('Scenario 7');

    const detailRes = await detailGET(
      new Request(
        `http://localhost/api/markets/predictions/${questionId}`
      ) as never,
      { params: Promise.resolve({ id: questionId }) }
    );
    const detailBody = (await detailRes.json()) as {
      market?: Record<string, unknown>;
    };
    expect(detailBody.market?.scenario).toBe(7);
  });
});

/** PRD §9.2 / §12 and MVP phases 5–6: carry the recorded question into the existing terminal. */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedPredictionMarketScenarioCase,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs the terminal prediction scenario case in a leased fresh database', async () => {
    await runIsolatedPredictionMarketScenarioCase();
  }, 300_000);
} else {
  // The idempotent adapter can return another writer's row. Retire the
  // verified database lease instead of trying to infer row ownership.
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));
  const { PredictionDbAdapter } = await import('@feed/core/markets/prediction');
  const { db, eq, markets, questions } = await import('@feed/db');
  const { NextRequest } = await import('next/server');
  const { GET: detailGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/route'
  );
  const { GET: listGET } = await import(
    '../../../apps/web/src/app/api/markets/predictions/route'
  );
  const listingPath = '/api/markets/predictions';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const id = new URL(request.url).pathname.slice(listingPath.length + 1);
      const nextRequest = new NextRequest(request);
      return id
        ? detailGET(nextRequest, { params: Promise.resolve({ id }) })
        : listGET(nextRequest);
    },
  });

  afterAll(async () => {
    try {
      await server.stop(true);
    } finally {
      await db.$disconnect();
    }
  });

  type Scenario = { id: string; scenario: number | null };
  async function read<T>(path: string): Promise<T> {
    const requestId = crypto.randomUUID();
    const response = await fetch(new URL(path, server.url), {
      headers: { 'x-request-id': requestId },
    });
    expect(response.status).toBe(200);
    console.info('Prediction terminal response', {
      requestId,
      path,
      status: response.status,
    });
    return (await response.json()) as T;
  }

  test('keeps the recorded scenario across adapter and terminal HTTP reads', async () => {
    const questionId = crypto.randomUUID();
    const withoutQuestion = crypto.randomUUID();
    const endDate = new Date(Date.now() + 86_400_000);
    const [question] = await db
      .insert(questions)
      .values({
        id: questionId,
        questionNumber: 1,
        text: 'Scenario wiring: will the number reach the terminal?',
        scenarioId: 7,
        outcome: false,
        rank: 1,
        resolutionDate: endDate,
        updatedAt: new Date(),
      })
      .returning();
    if (!question) throw new Error('Question insert returned no row');
    await db.insert(markets).values({
      id: withoutQuestion,
      question: 'Prediction without a linked question',
      liquidity: '1000',
      endDate,
      updatedAt: new Date(),
    });

    const adapter = new PredictionDbAdapter();
    const record = { ...question, status: 'active' as const };
    const created = await adapter.createMarketFromQuestion(record, 1000);
    expect(created.scenario).toBe(7);

    const before = await db
      .select()
      .from(markets)
      .where(eq(markets.id, questionId));
    // This call attempts the same insert, so the original market must win.
    const existing = await adapter.createMarketFromQuestion(record, 2000);
    expect(existing.id).toBe(created.id);
    expect(existing.liquidity).toBe(1000);
    const after = await db
      .select()
      .from(markets)
      .where(eq(markets.id, questionId));
    expect(after).toEqual(before);

    const byId = await adapter.getMarketById(questionId);
    expect(byId?.scenario).toBe(7);
    const batch = await adapter.getMarketsByIds([questionId, withoutQuestion]);
    expect(batch.find((market) => market.id === questionId)?.scenario).toBe(7);
    expect(
      batch.find((market) => market.id === withoutQuestion)?.scenario
    ).toBeUndefined();

    const list = await read<{ questions: Scenario[] }>(
      `${listingPath}?limit=100&page=1`
    );
    expect(list.questions).toContainEqual(
      expect.objectContaining({ id: questionId, scenario: 7 })
    );
    expect(list.questions).toContainEqual(
      expect.objectContaining({ id: withoutQuestion, scenario: null })
    );
    const detail = await read<{ market: Scenario }>(
      `${listingPath}/${questionId}`
    );
    expect(detail.market.scenario).toBe(7);
    const legacy = await read<{ market: Scenario }>(
      `${listingPath}/${withoutQuestion}`
    );
    expect(legacy.market.scenario).toBeNull();
  });
}

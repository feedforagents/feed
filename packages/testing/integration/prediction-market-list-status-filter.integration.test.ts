/**
 * PRD §9.2 / MVP Phase 6. Prediction market list filters use the retained
 * lifecycle columns and leave the detail response contract alone.
 */
import { beforeAll, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  resolved: 'status=RESOLVED pages only outcome rows in stable order',
  cancelled: 'status=CANCELLED lists no-outcome closures including legacy rows',
  active: 'status=ACTIVE lists only unresolved unexpired markets',
  default: 'omitted status keeps the open list',
  cache: 'status-only slices stay separate and all refresh on invalidation',
  detail: 'legacy deactivated market detail retains its existing response',
  invalid: 'invalid status returns 400',
};

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();
  const { dbWrite, markets, questions } = await import('@feed/db');
  const { invalidateMarketsApiPredictionsList } = await import('@feed/api');
  const { NextRequest } = await import('next/server');
  const { GET } = await import('@/app/api/markets/predictions/route');
  const { GET: getDetail } = await import(
    '@/app/api/markets/predictions/[id]/route'
  );
  const { z } = await import('zod');

  const active = 'm1993-active';
  const expired = 'm1993-expired';
  const yes = 'm1993-resolved-yes';
  const no = 'm1993-resolved-no';
  const cancelled = 'm1993-cancelled';
  const legacyVoid = 'm1993-legacy-void';
  const deactivated = 'm1993-deactivated';
  const now = Date.now();
  const past = new Date(now - 86_400_000);
  const future = new Date(now + 86_400_000);
  const client = crypto.randomUUID().slice(0, 4);
  let sequence = 0;

  const entry = z.object({
    id: z.string(),
    status: z.string(),
    resolved: z.boolean(),
    resolution: z.boolean().nullable(),
    scenario: z.number().nullable(),
  });
  const list = z.object({
    success: z.literal(true),
    questions: z.array(entry),
    total: z.number().optional(),
    count: z.number(),
  });

  function market(
    id: string,
    overrides: Partial<typeof markets.$inferInsert> = {}
  ): typeof markets.$inferInsert {
    return {
      id,
      question: id,
      yesShares: '1000',
      noShares: '1000',
      liquidity: '1000',
      endDate: future,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ...overrides,
    };
  }

  function request(suffix: string) {
    return new NextRequest(
      `http://localhost/api/markets/predictions${suffix}`,
      {
        headers: {
          'x-forwarded-for': `2001:db8:1993:${client}::${++sequence}`,
        },
      }
    );
  }

  async function fetchList(query: string) {
    const response = await GET(request(query));
    expect(response.status).toBe(200);
    return list.parse(await response.json());
  }

  beforeAll(async () => {
    await dbWrite.insert(markets).values([
      market(active),
      market(expired, { endDate: past }),
      market(yes, { endDate: past, resolved: true, resolution: true }),
      market(no, { endDate: past, resolved: true, resolution: false }),
      market(cancelled, {
        endDate: past,
        resolved: true,
        resolutionDescription: 'Market cancelled',
      }),
      market(legacyVoid, {
        endDate: past,
        resolved: true,
        resolutionDescription: 'Market voided by admin',
      }),
      market(deactivated, { resolved: true }),
    ]);
    await dbWrite.insert(questions).values({
      id: yes,
      questionNumber: 1993001,
      text: 'Resolved outcome scenario',
      scenarioId: 1993,
      outcome: true,
      rank: 1,
      resolutionDate: past,
      status: 'resolved',
      resolvedOutcome: true,
      updatedAt: new Date(now),
    });
  });

  test(cases.resolved, async () => {
    const first = await fetchList('?status=RESOLVED&limit=1&page=1');
    const second = await fetchList('?status=RESOLVED&limit=1&page=2');
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(first.questions[0]).toMatchObject({
      id: yes,
      status: 'resolved',
      resolution: true,
      scenario: 1993,
    });
    expect(second.questions[0]).toMatchObject({
      id: no,
      status: 'resolved',
      resolution: false,
    });
  });

  test(cases.cancelled, async () => {
    const body = await fetchList('?status=CANCELLED&limit=100');
    expect(body.total).toBe(3);
    expect(body.questions.map(({ id }) => id)).toEqual([
      legacyVoid,
      deactivated,
      cancelled,
    ]);
    for (const row of body.questions) {
      expect(row).toMatchObject({
        status: 'cancelled',
        resolved: true,
        resolution: null,
      });
    }
  });

  test(cases.active, async () => {
    const body = await fetchList('?status=ACTIVE&page=1');
    expect(body.total).toBe(1);
    expect(body.questions[0]).toMatchObject({ id: active, status: 'active' });
  });

  test(cases.default, async () => {
    const body = await fetchList('?limit=100');
    expect(body.total).toBe(1);
    expect(body.questions.map(({ id }) => id)).toEqual([active]);
  });

  test(cases.cache, async () => {
    const originalActive = await fetchList('');
    const originalResolved = await fetchList('?status=RESOLVED');
    const originalCancelled = await fetchList('?status=CANCELLED');
    for (const body of [originalActive, originalResolved, originalCancelled]) {
      expect(body.total).toBeUndefined();
    }
    expect(originalActive.questions.map(({ id }) => id)).toEqual([active]);
    expect(originalResolved.questions.map(({ id }) => id)).toEqual([yes, no]);
    expect(originalCancelled.questions.map(({ id }) => id)).toEqual([
      legacyVoid,
      deactivated,
      cancelled,
    ]);

    await dbWrite
      .insert(markets)
      .values([
        market('m1993-new-active'),
        market('m1993-new-resolved', { resolved: true, resolution: true }),
        market('m1993-new-cancelled', { resolved: true }),
      ]);
    expect(await fetchList('?status=RESOLVED')).toEqual(originalResolved);
    expect(await fetchList('?status=CANCELLED')).toEqual(originalCancelled);
    expect(await fetchList('?status=ACTIVE')).toEqual(originalActive);

    await invalidateMarketsApiPredictionsList();
    expect((await fetchList('')).count).toBe(2);
    expect((await fetchList('?status=RESOLVED')).count).toBe(3);
    expect((await fetchList('?status=CANCELLED')).count).toBe(4);
  });

  test(cases.detail, async () => {
    const response = await getDetail(request(`/${deactivated}`), {
      params: Promise.resolve({ id: deactivated }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      market: {
        id: deactivated,
        status: 'resolved',
        resolved: true,
        resolution: null,
      },
    });
  });

  test(cases.invalid, async () => {
    expect((await GET(request('?status=BOGUS&limit=10'))).status).toBe(400);
  });
} else {
  test('prediction market filters on a verified database lease', async () => {
    await runIsolatedSubMarketCases({
      name: 'prediction-market-list-status',
      file: 'packages/testing/integration/prediction-market-list-status-filter.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 60_000);
}

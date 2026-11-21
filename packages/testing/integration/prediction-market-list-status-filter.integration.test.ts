/**
 * PRD §9.2 / MarketQuerySchema: GET /api/markets/predictions accepts a
 * `status` filter (ACTIVE | RESOLVED | CANCELLED — an invalid value is a
 * 400), and the response reports each market's `status`. A caller asking
 * for resolved markets must get resolved markets, not the open list.
 *
 * Real route + real database test. Fixtures are owned by this file (unique
 * id prefix, snapshot-guarded cleanup); no other rows are touched.
 * Assertions are inclusion/exclusion over the owned ids plus the per-row
 * `status` field, so unrelated rows in a shared disposable database cannot
 * flip the verdict — only the owned ids decide it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dbWrite, markets, sql } from '@feed/db';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { GET as PredictionsGet } from '@/app/api/markets/predictions/route';

type StoredRow = { id: string; snapshot: string };

const owned = new Map<string, StoredRow>();
const prefix = `f-w5b-status-${crypto.randomUUID()}`;
const activeId = `${prefix}-active`;
const expiredId = `${prefix}-expired`;
const resolvedYesId = `${prefix}-resolved-yes`;
const resolvedNoId = `${prefix}-resolved-no`;
const cancelledId = `${prefix}-cancelled`;

let GET: typeof PredictionsGet;
let fixtureTime: number;
let clientSequence = 0;
const ipPrefix = crypto
  .randomUUID()
  .replaceAll('-', '')
  .slice(0, 16)
  .match(/.{4}/g)!
  .join(':');

const listSchema = z.object({
  success: z.literal(true),
  questions: z.array(
    z.object({ id: z.string(), status: z.string() }).passthrough()
  ),
  total: z.number().int().nonnegative().optional(),
  count: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

function clientIp() {
  if (++clientSequence > 65535)
    throw new Error('Fixture client budget exceeded');
  return `2001:db8:1734:${ipPrefix}:${clientSequence.toString(16)}`;
}

async function insertMarkets(values: Array<typeof markets.$inferInsert>) {
  const rows = await dbWrite
    .insert(markets)
    .values(values)
    .returning({
      id: markets.id,
      snapshot: sql<string>`to_jsonb(${markets})::text`,
    });
  for (const row of rows) owned.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Market RETURNING');
  return rows;
}

async function readRow(id: string) {
  return dbWrite.execute<StoredRow>(sql`
    SELECT id, to_jsonb(t)::text AS snapshot FROM "Market" t WHERE id = ${id}
  `);
}

async function cleanup() {
  const failures: Error[] = [];
  for (const row of [...owned.values()]) {
    try {
      await dbWrite.execute(sql`DELETE FROM "Market" t
        WHERE id = ${row.id} AND to_jsonb(t) = ${row.snapshot}::text::jsonb AND (
          NOT EXISTS (SELECT 1 FROM "Position" WHERE "marketId" = ${row.id}) AND
          NOT EXISTS (SELECT 1 FROM "PredictionPriceHistory" WHERE "marketId" = ${row.id})
        )`);
      if ((await readRow(row.id)).length)
        throw new Error(`Owned fixture row retained: Market/${row.id}`);
      owned.delete(row.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned market fixture cleanup incomplete'
    );
}

function market(
  id: string,
  overrides: Partial<typeof markets.$inferInsert>
): typeof markets.$inferInsert {
  return {
    id,
    question: `Owned status-filter market ${id}`,
    yesShares: '1000',
    noShares: '1000',
    liquidity: '1000',
    resolved: false,
    endDate: new Date(fixtureTime + 7 * 86400000),
    createdAt: new Date(fixtureTime),
    updatedAt: new Date(fixtureTime),
    ...overrides,
  };
}

async function fetchList(query: string) {
  const response = await GET(
    new NextRequest(`http://localhost/api/markets/predictions${query}`, {
      headers: { 'x-forwarded-for': clientIp() },
    })
  );
  expect(response.status).toBe(200);
  return listSchema.parse(await response.json());
}

function ids(body: z.infer<typeof listSchema>) {
  return body.questions.map((row) => row.id);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/test_db', '/feed_w5b'].includes(url.pathname) ||
    url.search ||
    url.hash ||
    !['5432', '5433', '55685'].includes(url.port) ||
    process.env.DATABASE_READ_REPLICA_URL
  )
    throw new Error('Owned local disposable primary database required');
  if (
    process.env.DIRECT_DATABASE_URL &&
    new URL(process.env.DIRECT_DATABASE_URL).href !== url.href
  )
    throw new Error('Direct test database must match primary');
  GET = (await import('@/app/api/markets/predictions/route')).GET;
  fixtureTime = Date.now();
  await insertMarkets([
    market(activeId, {}),
    market(expiredId, { endDate: new Date(fixtureTime - 86400000) }),
    market(resolvedYesId, {
      resolved: true,
      resolution: true,
      endDate: new Date(fixtureTime - 86400000),
    }),
    market(resolvedNoId, {
      resolved: true,
      resolution: false,
      endDate: new Date(fixtureTime - 86400000),
    }),
    market(cancelledId, {
      resolved: true,
      resolution: null,
      endDate: new Date(fixtureTime - 86400000),
    }),
  ]);
});
afterAll(async () => cleanup());

describe('prediction market list status filter', () => {
  test('status=RESOLVED lists only resolved markets', async () => {
    const body = await fetchList('?status=RESOLVED&limit=100&page=1');
    const seen = ids(body);
    expect(seen).toContain(resolvedYesId);
    expect(seen).toContain(resolvedNoId);
    expect(seen).not.toContain(activeId);
    expect(seen).not.toContain(expiredId);
    expect(seen).not.toContain(cancelledId);
    for (const row of body.questions) {
      expect(row.status).toBe('resolved');
    }
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test('status=CANCELLED lists only the cancelled market', async () => {
    const body = await fetchList('?status=CANCELLED&limit=100&page=1');
    const seen = ids(body);
    expect(seen).toContain(cancelledId);
    expect(seen).not.toContain(activeId);
    expect(seen).not.toContain(expiredId);
    expect(seen).not.toContain(resolvedYesId);
    expect(seen).not.toContain(resolvedNoId);
    expect(body.questions.find((row) => row.id === cancelledId)?.status).toBe(
      'cancelled'
    );
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  test('status=ACTIVE lists only the active market', async () => {
    const body = await fetchList('?status=ACTIVE&limit=100&page=1');
    const seen = ids(body);
    expect(seen).toContain(activeId);
    expect(seen).not.toContain(expiredId);
    expect(seen).not.toContain(resolvedYesId);
    expect(seen).not.toContain(resolvedNoId);
    expect(seen).not.toContain(cancelledId);
    expect(body.questions.find((row) => row.id === activeId)?.status).toBe(
      'active'
    );
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  test('no status keeps the current open-list behavior', async () => {
    const body = await fetchList('?limit=100&page=1');
    const seen = ids(body);
    expect(seen).toContain(activeId);
    expect(seen).not.toContain(expiredId);
    expect(seen).not.toContain(resolvedYesId);
    expect(seen).not.toContain(resolvedNoId);
    expect(seen).not.toContain(cancelledId);
  });

  test('unpaginated status=RESOLVED also lists only resolved markets', async () => {
    const body = await fetchList('?status=RESOLVED');
    const seen = ids(body);
    expect(seen).toContain(resolvedYesId);
    expect(seen).toContain(resolvedNoId);
    expect(seen).not.toContain(activeId);
    expect(seen).not.toContain(cancelledId);
    for (const row of body.questions) {
      expect(row.status).toBe('resolved');
    }
  });

  test('invalid status is still rejected with 400', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/markets/predictions?status=BOGUS&limit=10',
        { headers: { 'x-forwarded-for': clientIp() } }
      )
    );
    expect(response.status).toBe(400);
  });
});

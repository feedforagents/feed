/**
 * PRD §9.2 / MVP Phase 6: retained prediction lists have stable page boundaries.
 * These real route/database tests use stable rows, a relative future expiry,
 * and bounded independent public-client budgets. They do not prove snapshots
 * across concurrent writes or normal-server quota enforcement in CI bypass mode.
 * Ownership begins at INSERT RETURNING; cleanup preserves changed tuples and
 * foreign Question links instead of invoking the Market FK's SET NULL action.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dbWrite, inArray, markets, questions, sql } from '@feed/db';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { GET as PredictionsGet } from '@/app/api/markets/predictions/route';

type StoredRow = { id: string; snapshot: string };
function ownership() {
  return {
    markets: new Map<string, StoredRow>(),
    questions: new Map<string, StoredRow>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
const prefix = `f19-probe-${crypto.randomUUID()}`;
const TIE_COUNT = 300;
const MAX_TOTAL = 1000;
const CLIENT_REQUEST_BUDGET = 10;
// Proposed IDs name fixtures; they never authorize deletion.
const tieIds = Array.from(
  { length: TIE_COUNT },
  (_, i) => `${prefix}-tie-${String(i).padStart(4, '0')}`
);
const distinctIds = Array.from(
  { length: 30 },
  (_, i) => `${prefix}-distinct-${String(i).padStart(4, '0')}`
);
const expiredId = `${prefix}-expired`,
  resolvedId = `${prefix}-resolved`;
let GET: typeof PredictionsGet;
let clientSequence = 0;
let fixtureTime: number;
const ipPrefix = crypto
  .randomUUID()
  .replaceAll('-', '')
  .slice(0, 16)
  .match(/.{4}/g)!
  .join(':');
const pageSchema = z.object({
  success: z.literal(true),
  questions: z.array(z.object({ id: z.string() }).passthrough()),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
});

function clientIp() {
  if (++clientSequence > 65535)
    throw new Error('Fixture client budget exceeded');
  return `2001:db8:1734:${ipPrefix}:${clientSequence.toString(16)}`;
}

async function insertMarkets(
  values: Array<typeof markets.$inferInsert>,
  receipt = owned
) {
  const rows = await dbWrite
    .insert(markets)
    .values(values)
    .returning({
      id: markets.id,
      snapshot: sql<string>`to_jsonb(${markets})::text`,
    });
  for (const row of rows) receipt.markets.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Market RETURNING');
  return rows;
}
async function insertQuestions(
  values: Array<typeof questions.$inferInsert>,
  receipt: Ownership
) {
  const rows = await dbWrite
    .insert(questions)
    .values(values)
    .returning({
      id: questions.id,
      snapshot: sql<string>`to_jsonb(${questions})::text`,
    });
  for (const row of rows) receipt.questions.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Question RETURNING');
  return rows;
}
async function readRow(table: 'Market' | 'Question', id: string) {
  return dbWrite.execute<StoredRow>(sql`
    SELECT id, to_jsonb(t)::text AS snapshot FROM ${sql.identifier(table)} t WHERE id = ${id}
  `);
}
async function cleanup(receipt = owned) {
  const failures: Error[] = [];
  for (const [table, rows] of [
    ['Question', receipt.questions],
    ['Market', receipt.markets],
  ] as const) {
    for (const row of [...rows.values()]) {
      try {
        const guard =
          table === 'Market'
            ? sql`
          NOT EXISTS (SELECT 1 FROM "Question" WHERE "marketId" = ${row.id}) AND
          NOT EXISTS (SELECT 1 FROM "Position" WHERE "marketId" = ${row.id}) AND
          NOT EXISTS (SELECT 1 FROM "PredictionPriceHistory" WHERE "marketId" = ${row.id})
        `
            : sql`
          NOT EXISTS (SELECT 1 FROM "ArcState" WHERE "questionId" = ${row.id}) AND
          NOT EXISTS (SELECT 1 FROM "QuestionArcPlan" WHERE "questionId" = ${row.id}) AND
          NOT EXISTS (SELECT 1 FROM "TimeframedMarket" WHERE "questionId" = ${row.id})
        `;
        await dbWrite.execute(sql`DELETE FROM ${sql.identifier(table)} t
          WHERE id = ${row.id} AND to_jsonb(t) = ${row.snapshot}::text::jsonb AND (${guard})`);
        if ((await readRow(table, row.id)).length)
          throw new Error(`Owned fixture row retained: ${table}/${row.id}`);
        rows.delete(row.id);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failures.push(error);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned market fixture cleanup incomplete'
    );
}
async function expectUnchanged(receipt: Ownership) {
  for (const [table, rows] of [
    ['Market', receipt.markets],
    ['Question', receipt.questions],
  ] as const)
    for (const row of rows.values())
      expect([...(await readRow(table, row.id))]).toEqual([row]);
}

async function fetchPage(page: number, limit: number, ip: string) {
  const response = await GET(
    new NextRequest(
      `http://localhost/api/markets/predictions?page=${page}&limit=${limit}`,
      { headers: { 'x-forwarded-for': ip } }
    )
  );
  expect(response.status).toBe(200);
  const body = pageSchema.parse(await response.json());
  expect(body.page).toBe(page);
  expect(body.limit).toBe(limit);
  expect(body.count).toBe(body.questions.length);
  expect(body.questions.length).toBeLessThanOrEqual(limit);
  return body;
}
async function walkAll(limit: number, wanted: string[]) {
  const wantedSet = new Set(wanted),
    seen: string[] = [];
  let total: number | undefined,
    maxPages = Math.ceil(MAX_TOTAL / limit) + 1;
  let ip = '',
    terminalPage = false;
  for (let page = 1; page <= maxPages; page++) {
    // Each bounded client batch stays below the actual normal public quota.
    // Normal single-client 429 evidence is a separate strict-server flow.
    if ((page - 1) % CLIENT_REQUEST_BUDGET === 0) ip = clientIp();
    const body = await fetchPage(page, limit, ip);
    if (total === undefined) {
      total = body.total;
      expect(total).toBeGreaterThanOrEqual(TIE_COUNT + distinctIds.length);
      expect(total).toBeLessThanOrEqual(MAX_TOTAL);
      maxPages = Math.ceil(total / limit) + 1;
    }
    expect(body.total).toBe(total);
    if (body.questions.length === 0) {
      terminalPage = true;
      break;
    }
    seen.push(...body.questions.map((row) => row.id));
  }
  expect(terminalPage).toBe(true);
  expect(seen.length).toBe(total!);
  return seen.filter((id) => wantedSet.has(id));
}

function market(
  id: string,
  createdAt = new Date(fixtureTime)
): typeof markets.$inferInsert {
  return {
    id,
    question: `Owned pagination market ${id}`,
    yesShares: '1000',
    noShares: '1000',
    liquidity: '1000',
    resolved: false,
    endDate: new Date(fixtureTime + 7 * 86400000),
    createdAt,
    updatedAt: new Date(fixtureTime),
  };
}
async function nextQuestionNumber() {
  const rows = await dbWrite.execute<{ value: number }>(
    sql`SELECT coalesce(max("questionNumber"), 0) + 1 AS value FROM "Question"`
  );
  const value = Number(rows[0]?.value);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error('No bounded control Question number available');
  return value;
}
async function seedQuestion(id: string, marketId: string, receipt: Ownership) {
  return insertQuestions(
    [
      {
        id,
        marketId,
        questionNumber: await nextQuestionNumber(),
        text: 'Foreign Question ownership control',
        scenarioId: 1,
        outcome: false,
        rank: 1,
        resolutionDate: new Date(fixtureTime + 7 * 86400000),
        createdDate: new Date(fixtureTime),
        createdAt: new Date(fixtureTime),
        updatedAt: new Date(fixtureTime),
      },
    ],
    receipt
  );
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/(test_db|feed_pr\d+)$/.test(url.pathname) ||
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
  await insertMarkets(tieIds.map((id) => market(id)));
  await insertMarkets(
    distinctIds.map((id, i) =>
      market(id, new Date(fixtureTime + (i + 1) * 1000))
    )
  );
  await insertMarkets([
    { ...market(expiredId), endDate: new Date(fixtureTime - 86400000) },
    { ...market(resolvedId), resolved: true, resolution: true },
  ]);
});
afterAll(async () => cleanup());

describe('prediction market list pagination reachability', () => {
  test('precondition: tie fixture shares exactly one createdAt', async () => {
    const rows = await dbWrite
      .select({ c: sql<number>`count(distinct ${markets.createdAt})` })
      .from(markets)
      .where(inArray(markets.id, tieIds));
    expect(Number(rows[0]?.c)).toBe(1);
  });
  test('paging reaches every same-createdAt market exactly once (limit=25, 3 walks)', async () => {
    for (let walk = 0; walk < 3; walk++) {
      const seen = await walkAll(25, tieIds);
      expect(seen.length).toBe(TIE_COUNT);
      expect(new Set(seen).size).toBe(TIE_COUNT);
      expect([...new Set(seen)].sort()).toEqual([...tieIds].sort());
      expect(seen).toEqual([...tieIds].reverse());
    }
  });
  test('paging reaches every same-createdAt market exactly once (limit=7)', async () => {
    const seen = await walkAll(7, tieIds);
    expect(seen.length).toBe(TIE_COUNT);
    expect(new Set(seen).size).toBe(TIE_COUNT);
    expect(seen).toEqual([...tieIds].reverse());
  });
  test('distinct-createdAt markets page cleanly (control)', async () => {
    const seen = await walkAll(10, distinctIds);
    expect(seen.length).toBe(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual([...distinctIds].reverse());
  });
  test('retains current expiry and resolved-market exclusions', async () => {
    expect(await walkAll(100, [expiredId, resolvedId])).toEqual([]);
  });

  test('acquires no rows after true primary-key collisions and cleans partial setup only', async () => {
    const foreign = ownership(),
      partial = ownership(),
      attempted = ownership();
    try {
      const [existing] = await insertMarkets(
        [market(`${prefix}-collision-market`)],
        foreign
      );
      await seedQuestion(`${prefix}-collision-question`, existing!.id, foreign);
      const [part] = await insertMarkets(
        [market(`${prefix}-partial-market`)],
        partial
      );
      await seedQuestion(`${prefix}-partial-question`, part!.id, partial);
      for (const [table, row] of [
        ['Market', existing!],
        ['Question', [...foreign.questions.values()][0]!],
      ] as const) {
        let duplicate = false;
        const change =
          table === 'Market'
            ? sql`jsonb_build_object('question', 'Unowned collision proposal')`
            : sql`jsonb_build_object('questionNumber', ${await nextQuestionNumber()}::integer)`;
        try {
          const rows =
            await dbWrite.execute<StoredRow>(sql`INSERT INTO ${sql.identifier(table)}
            SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(table)}, ${row.snapshot}::text::jsonb || ${change})
            RETURNING id, to_jsonb(${sql.identifier(table)})::text AS snapshot`);
          for (const inserted of rows)
            (table === 'Market' ? attempted.markets : attempted.questions).set(
              inserted.id,
              inserted
            );
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const cause = error.cause instanceof Error ? error.cause : error;
          if (!('code' in cause) || cause.code !== '23505') throw error;
          duplicate = true;
        }
        expect(duplicate).toBe(true);
      }
      expect(attempted.markets.size).toBe(0);
      expect(attempted.questions.size).toBe(0);
      await cleanup(attempted);
      await cleanup(partial);
      expect(partial.markets.size).toBe(0);
      expect(partial.questions.size).toBe(0);
      await expectUnchanged(foreign);
    } finally {
      await cleanup(attempted);
      await cleanup(partial);
      await cleanup(foreign);
    }
  });

  test('refuses foreign Question links and changed owned market tuples', async () => {
    const subject = ownership(),
      foreign = ownership();
    try {
      const [row] = await insertMarkets(
        [market(`${prefix}-foreign-question-subject`)],
        subject
      );
      await seedQuestion(`${prefix}-foreign-question`, row!.id, foreign);
      await expect(cleanup(subject)).rejects.toThrow(
        'Owned market fixture cleanup incomplete'
      );
      expect(subject.markets.size).toBe(1);
      await expectUnchanged(subject);
      await expectUnchanged(foreign);
      await cleanup(foreign);
      await dbWrite.execute(
        sql`UPDATE "Market" SET question = 'Changed owned tuple control' WHERE id = ${row!.id}`
      );
      const changed = [...(await readRow('Market', row!.id))];
      await expect(cleanup(subject)).rejects.toThrow(
        'Owned market fixture cleanup incomplete'
      );
      expect(subject.markets.get(row!.id)).toEqual(row!);
      expect([...(await readRow('Market', row!.id))]).toEqual(changed);
      await dbWrite.execute(
        sql`UPDATE "Market" SET question = (${row!.snapshot}::text::jsonb ->> 'question') WHERE id = ${row!.id}`
      );
    } finally {
      await cleanup(foreign);
      await cleanup(subject);
    }
  });
});

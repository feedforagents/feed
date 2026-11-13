/** Real HTTP closed-history coverage. Seeded history is not evidence of executing trades. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  dbWrite,
  eq,
  gameOnboarding,
  markets,
  perpPositions,
  positions,
  questions,
  sql,
  type Transaction,
  users,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { fetchClosedPositionsSnapshot } from '../../../apps/web/src/components/wallet/v2/closed-positions-pages';

type Table =
  | 'User'
  | 'Market'
  | 'PerpPosition'
  | 'Position'
  | 'Question'
  | 'GameOnboarding';
type Receipt = { table: Table; id: string; row: string };
const acquired: Receipt[] = [];
const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const now = Date.now();
const closedIds: string[] = [];
const openIds: string[] = [];
const predictionIds: string[] = [];
const excludedPredictionIds: string[] = [];
let userId = '';

function guardDisposableTarget() {
  const rawDatabase = process.env.DATABASE_URL || '';
  if (!URL.canParse(rawDatabase) || !URL.canParse(BASE_URL))
    throw new Error('Invalid disposable test target');
  const database = new URL(rawDatabase);
  const local =
    database.hostname === '127.0.0.1' &&
    database.port === '55685' &&
    database.username === 'symbiex' &&
    /^\/feed_pr1705\d+$/.test(database.pathname);
  const ci =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    ['localhost', '127.0.0.1'].includes(database.hostname) &&
    database.port === '5432' &&
    database.username === 'postgres' &&
    database.pathname === '/test_db';
  if (
    database.protocol !== 'postgresql:' ||
    database.search ||
    database.hash ||
    !(local || ci) ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== process.env.DATABASE_URL) ||
    process.env.DATABASE_READ_REPLICA_URL ||
    process.env.POSTGRES_URL
  ) {
    throw new Error(
      'Closed-history fixtures require an explicit disposable local or CI database'
    );
  }
  for (const value of [process.env.TEST_API_URL, process.env.TEST_BASE_URL]) {
    if (value && !URL.canParse(value))
      throw new Error('Invalid loopback HTTP target');
  }
  const base = new URL(BASE_URL);
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    (process.env.TEST_API_URL &&
      process.env.TEST_BASE_URL &&
      new URL(process.env.TEST_API_URL).origin !==
        new URL(process.env.TEST_BASE_URL).origin)
  ) {
    throw new Error('Closed-history HTTP target must be one loopback origin');
  }
}

function remember(
  table: Table,
  rows: Array<{ id: string; row: string }>,
  into = acquired
) {
  for (const row of rows) into.push({ table, ...row });
  return rows;
}
async function insertUser(into = acquired) {
  const id = await generateSnowflakeId();
  const rows = remember(
    'User',
    await dbWrite
      .insert(users)
      .values({
        id,
        username: `g29-${id}`,
        displayName: 'Closed history fixture',
        updatedAt: new Date(now),
      })
      .returning({ id: users.id, row: sql<string>`to_jsonb("User")::text` }),
    into
  );
  if (rows.length !== 1 || !rows[0])
    throw new Error('User INSERT did not return one acquired row');
  return rows[0];
}
async function insertMarket(into = acquired) {
  const id = await generateSnowflakeId();
  const rows = remember(
    'Market',
    await dbWrite
      .insert(markets)
      .values({
        id,
        question: `Owned closed history ${id}`,
        liquidity: '1000',
        yesShares: '1000',
        noShares: '1000',
        endDate: new Date(now + 86_400_000),
        updatedAt: new Date(now),
      })
      .returning({
        id: markets.id,
        row: sql<string>`to_jsonb("Market")::text`,
      }),
    into
  );
  if (rows.length !== 1 || !rows[0])
    throw new Error('Market INSERT did not return one acquired row');
  return rows[0];
}
async function readReceipt(row: Receipt) {
  return Array.from(
    await dbWrite.execute<{ row: string }>(sql`SELECT to_jsonb(t)::text AS row
    FROM ${sql.identifier(row.table)} t WHERE id=${row.id}`)
  );
}
function parentGuard(table: Table) {
  if (table === 'User')
    return sql`
    NOT EXISTS(SELECT 1 FROM "PerpPosition" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Position" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "AdminRole" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "GameOnboarding" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Whitelist" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "WhitelistConfig" c WHERE c."updatedBy"=t.id)`;
  if (table === 'Market')
    return sql`
    NOT EXISTS(SELECT 1 FROM "Question" c WHERE c."marketId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Position" c WHERE c."marketId"=t.id)`;
  if (table === 'Question')
    return sql`
    NOT EXISTS(SELECT 1 FROM "ArcState" c WHERE c."questionId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "QuestionArcPlan" c WHERE c."questionId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "TimeframedMarket" c WHERE c."questionId"=t.id)`;
  return sql`true`;
}
async function erase(tx: Transaction, row: Receipt) {
  const removed = await tx.execute<{
    id: string;
  }>(sql`DELETE FROM ${sql.identifier(row.table)} t
    WHERE t.id=${row.id} AND to_jsonb(t)=${row.row}::text::jsonb AND ${parentGuard(row.table)} RETURNING t.id`);
  if (removed.length !== 1 || removed[0]?.id !== row.id)
    throw new Error(`Retain changed or referenced ${row.table}`);
}
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await withTransaction(async (tx) => {
    // Lock parents before deleting children so physical FK insertion cannot race cleanup.
    for (const row of rows
      .filter((r) => ['User', 'Market', 'Question'].includes(r.table))
      .sort((a, b) => (`${a.table}:${a.id}` < `${b.table}:${b.id}` ? -1 : 1))) {
      const locked = await tx.execute<{
        row: string;
      }>(sql`SELECT to_jsonb(t)::text AS row
        FROM ${sql.identifier(row.table)} t WHERE id=${row.id} FOR UPDATE`);
      if (locked.length !== 1 || locked[0]?.row !== row.row)
        throw new Error(`Retain changed ${row.table}`);
    }
    for (const table of [
      'GameOnboarding',
      'Question',
      'PerpPosition',
      'Position',
      'Market',
      'User',
    ] as const) {
      for (const row of rows.filter((r) => r.table === table))
        await erase(tx, row);
    }
  });
  for (const row of rows) expect(await readReceipt(row)).toEqual([]);
  rows.length = 0;
}

const PositionSchema = z
  .object({
    id: z.string(),
    closedAt: z.string().nullable().optional(),
    status: z.string().optional(),
    realizedPnL: z.number().optional(),
    pnl: z.number().nullable().optional(),
    resolvedAt: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
  })
  .passthrough();
const SectionSchema = z.object({
  positions: z.array(PositionSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
});
const SnapshotSchema = z.object({
  perpetuals: SectionSchema,
  predictions: SectionSchema,
});
async function requestSnapshot(
  status = 'all',
  type = 'all',
  page = 1,
  signal?: AbortSignal
) {
  guardDisposableTarget();
  const url = new URL(`/api/markets/positions/${userId}`, BASE_URL);
  url.search = new URLSearchParams({
    status,
    type,
    page: String(page),
    limit: '50',
  }).toString();
  const response = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(10_000),
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Positions HTTP ${response.status}`);
  if (new URL(response.url).origin !== new URL(BASE_URL).origin)
    throw new Error('Unexpected HTTP origin');
  return SnapshotSchema.parse(await response.json());
}

beforeAll(async () => {
  guardDisposableTarget();
  const health = await fetch(new URL('/api/health', BASE_URL), {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  expect(health.ok).toBe(true);
  await health.arrayBuffer();
  userId = (await insertUser()).id;
  const perps: Array<typeof perpPositions.$inferInsert> = [];
  const expected: Array<{ id: string; closedAt: number }> = [];
  for (let i = 84; i >= 0; i--) {
    const id = await generateSnowflakeId();
    // A real 25-row tie spans indexes 40..64, including the old page-50 boundary.
    const closedAt = now - (10 + (i >= 40 && i < 65 ? 40 : i)) * 60_000;
    perps.push({
      id,
      userId,
      organizationId: 'g29-fixture-org',
      ticker: 'G29X',
      side: 'long',
      entryPrice: 100,
      currentPrice: 101,
      size: 500,
      leverage: 2,
      liquidationPrice: 50,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      fundingPaid: 0,
      openedAt: new Date(now - (200 + i) * 60_000),
      lastUpdated: new Date(now - (200 + i) * 60_000),
      closedAt: new Date(closedAt),
      realizedPnL: i % 2 === 0 ? 10 : -5,
    });
    expected.push({ id, closedAt });
  }
  for (let i = 0; i < 3; i++)
    perps.push({
      id: await generateSnowflakeId(),
      userId,
      organizationId: 'g29-fixture-org',
      ticker: 'G29X',
      side: 'short',
      entryPrice: 100,
      currentPrice: 99,
      size: 250,
      leverage: 5,
      liquidationPrice: 150,
      unrealizedPnL: 1,
      unrealizedPnLPercent: 1,
      fundingPaid: 0,
      openedAt: new Date(now),
      lastUpdated: new Date(now),
      closedAt: null,
      realizedPnL: null,
    });
  const inserted = remember(
    'PerpPosition',
    await dbWrite.insert(perpPositions).values(perps).returning({
      id: perpPositions.id,
      row: sql<string>`to_jsonb("PerpPosition")::text`,
    })
  );
  expect(inserted).toHaveLength(88);
  expected.sort(
    (a, b) =>
      b.closedAt - a.closedAt || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1)
  );
  closedIds.push(...expected.map((r) => r.id));
  const closedSet = new Set(closedIds);
  openIds.push(
    ...inserted.filter((r) => !closedSet.has(r.id)).map((r) => r.id)
  );
  const market = await insertMarket();
  const predictions: Array<typeof positions.$inferInsert> = [];
  for (let i = 0; i < 61; i++)
    predictions.push({
      id: await generateSnowflakeId(),
      userId,
      marketId: market.id,
      side: true,
      shares: i === 60 ? '0' : '2',
      avgPrice: '.5',
      amount: '1',
      status:
        i < 57
          ? i % 2
            ? 'closed'
            : 'resolved'
          : i === 60
            ? 'closed'
            : 'active',
      outcome: i % 2 === 0,
      pnl: i % 2 ? '-.25' : '.5',
      createdAt: new Date(now - (100 + i) * 60_000),
      updatedAt: new Date(now),
      resolvedAt: i < 57 ? new Date(now - i * 60_000) : null,
    });
  const insertedPredictions = remember(
    'Position',
    await dbWrite.insert(positions).values(predictions).returning({
      id: positions.id,
      row: sql<string>`to_jsonb("Position")::text`,
    })
  );
  expect(insertedPredictions).toHaveLength(61);
  const returnedIds = new Set(insertedPredictions.map((r) => r.id));
  for (const p of predictions) {
    expect(returnedIds.has(p.id)).toBe(true);
    (p.status === 'active' || p.shares === '0'
      ? excludedPredictionIds
      : predictionIds
    ).push(p.id);
  }
});
afterAll(async () => {
  guardDisposableTarget();
  await cleanup(acquired);
});

async function completeClosed(signal?: AbortSignal) {
  let calls = 0;
  const result = await fetchClosedPositionsSnapshot(async (passedSignal) => {
    expect(passedSignal).toBe(signal);
    calls++;
    return requestSnapshot('all', 'all', 1, passedSignal);
  }, signal);
  expect(calls).toBe(1);
  return {
    perpetuals: z.array(PositionSchema).parse(result.perpetuals),
    predictions: z.array(PositionSchema).parse(result.predictions),
  };
}

describe('closed perp position history paging', () => {
  it('reports the full total on the first page the tab used to stop at', async () => {
    const firstPage = (await requestSnapshot('closed', 'perps')).perpetuals;
    expect(firstPage.positions).toHaveLength(50);
    expect(firstPage.total).toBe(85);
    expect(firstPage.hasMore).toBe(true);
  });

  it('collects every closed position exactly once, newest first', async () => {
    const rows = (await completeClosed()).perpetuals;
    expect(rows).toHaveLength(85);
    expect(new Set(rows.map((r) => r.id)).size).toBe(85);
    expect(rows.map((r) => r.id)).toEqual(closedIds);
    for (const id of openIds) expect(rows.map((r) => r.id)).not.toContain(id);
    const times = rows.map((r) => new Date(r.closedAt ?? 0).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('selects complete closed and resolved prediction history without active or zero-share rows', async () => {
    const snapshot = await requestSnapshot();
    expect(snapshot.predictions.total).toBe(60); // 57 closed/resolved + 3 active; zero shares remain excluded by the existing API.
    const rows = (await completeClosed()).predictions;
    expect(rows).toHaveLength(57);
    expect(rows.map((r) => r.id)).toEqual(predictionIds);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(['closed', 'resolved'])
    );
    for (const id of excludedPredictionIds)
      expect(rows.map((r) => r.id)).not.toContain(id);
    const combined = await completeClosed();
    const won =
      combined.perpetuals.filter((r) => (r.realizedPnL ?? 0) >= 0).length +
      combined.predictions.filter((r) => (r.pnl ?? 0) >= 0).length;
    const lost =
      combined.perpetuals.filter((r) => (r.realizedPnL ?? 0) < 0).length +
      combined.predictions.filter((r) => (r.pnl ?? 0) < 0).length;
    expect(won).toBe(72);
    expect(lost).toBe(70);
    expect(won + lost).toBe(142);
  });

  it('keeps a real 25-position timestamp tie in stable raw-ID order across the old cutoff', async () => {
    const rows = (await completeClosed()).perpetuals;
    const tied = rows.filter(
      (r) => r.closedAt === new Date(now - 50 * 60_000).toISOString()
    );
    expect(tied).toHaveLength(25);
    expect(rows.slice(40, 65).map((r) => r.id)).toEqual(tied.map((r) => r.id));
    expect(tied.map((r) => r.id)).toEqual(
      [...tied]
        .sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1))
        .map((r) => r.id)
    );
  });

  it('rejects incomplete section responses instead of returning partial history', async () => {
    const snapshot = await requestSnapshot();
    for (const section of ['perpetuals', 'predictions'] as const) {
      const partial = structuredClone(snapshot);
      partial[section].positions = partial[section].positions.slice(0, 50);
      await expect(
        fetchClosedPositionsSnapshot(async () => partial)
      ).rejects.toThrow();
      const hasMore = structuredClone(snapshot);
      hasMore[section].hasMore = true;
      await expect(
        fetchClosedPositionsSnapshot(async () => hasMore)
      ).rejects.toThrow();
    }
  });

  it('propagates fetch failure and never mutates the complete supplied snapshot', async () => {
    let calls = 0;
    await expect(
      fetchClosedPositionsSnapshot(async () => {
        calls++;
        throw new Error('Controlled failed history request');
      })
    ).rejects.toThrow('Controlled failed history request');
    expect(calls).toBe(1);
    const snapshot = await requestSnapshot();
    const before = JSON.stringify(snapshot);
    await fetchClosedPositionsSnapshot(async () => snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('cancels before a request and refuses a response after in-flight cancellation', async () => {
    const pre = new AbortController();
    pre.abort();
    let calls = 0;
    await expect(
      fetchClosedPositionsSnapshot(async () => {
        calls++;
        return {};
      }, pre.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
    const snapshot = await requestSnapshot();
    const inFlight = new AbortController();
    await expect(
      fetchClosedPositionsSnapshot(async (signal) => {
        calls++;
        expect(signal).toBe(inFlight.signal);
        inFlight.abort();
        return snapshot;
      }, inFlight.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('rejects duplicate row identities in a supposedly complete snapshot', async () => {
    const snapshot = await requestSnapshot();
    const first = snapshot.perpetuals.positions[0];
    const second = snapshot.perpetuals.positions[1];
    if (!first || !second)
      throw new Error('Expected two acquired fixture rows');
    second.id = first.id;
    await expect(
      fetchClosedPositionsSnapshot(async () => snapshot)
    ).rejects.toThrow();
  });

  it('does not acquire failed user or position inserts or delete their colliding rows', async () => {
    const user = acquired.find((r) => r.table === 'User' && r.id === userId);
    const position = acquired.find(
      (r) => r.table === 'PerpPosition' && r.id === closedIds[0]
    );
    if (!user || !position)
      throw new Error('Missing acquired collision controls');
    const collisionPositionId = position.id;
    const failed: Receipt[] = [];
    const laterUser = await generateSnowflakeId();
    const laterPosition = await generateSnowflakeId();
    async function failedUsers() {
      remember(
        'User',
        await dbWrite
          .insert(users)
          .values([
            {
              id: userId,
              username: `collision-${laterUser}`,
              updatedAt: new Date(now),
            },
            {
              id: laterUser,
              username: `later-${laterUser}`,
              updatedAt: new Date(now),
            },
          ])
          .returning({
            id: users.id,
            row: sql<string>`to_jsonb("User")::text`,
          }),
        failed
      );
    }
    async function failedPositions() {
      remember(
        'PerpPosition',
        await dbWrite
          .insert(perpPositions)
          .values(
            [collisionPositionId, laterPosition].map((id) => ({
              id,
              userId,
              organizationId: 'g29-fixture-org',
              ticker: 'G29X',
              side: 'long',
              entryPrice: 100,
              currentPrice: 101,
              size: 500,
              leverage: 2,
              liquidationPrice: 50,
              unrealizedPnL: 0,
              unrealizedPnLPercent: 0,
              fundingPaid: 0,
              openedAt: new Date(now),
              lastUpdated: new Date(now),
            }))
          )
          .returning({
            id: perpPositions.id,
            row: sql<string>`to_jsonb("PerpPosition")::text`,
          }),
        failed
      );
    }
    await expect(failedUsers()).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'User_pkey' },
    });
    await expect(failedPositions()).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'PerpPosition_pkey' },
    });
    expect(failed).toEqual([]);
    await cleanup(failed);
    expect(await readReceipt(user)).toEqual([{ row: user.row }]);
    expect(await readReceipt(position)).toEqual([{ row: position.row }]);
    expect(
      await dbWrite
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, laterUser))
    ).toEqual([]);
    expect(
      await dbWrite
        .select({ id: perpPositions.id })
        .from(perpPositions)
        .where(eq(perpPositions.id, laterPosition))
    ).toEqual([]);
  });

  it('refuses parent cleanup while a separately acquired physical child still refers to it', async () => {
    const subject: Receipt[] = [];
    const foreign: Receipt[] = [];
    try {
      const user = await insertUser(subject);
      remember(
        'GameOnboarding',
        await dbWrite
          .insert(gameOnboarding)
          .values({
            id: await generateSnowflakeId(),
            userId: user.id,
          })
          .returning({
            id: gameOnboarding.id,
            row: sql<string>`to_jsonb("GameOnboarding")::text`,
          }),
        foreign
      );
      await expect(cleanup(subject)).rejects.toThrow(
        'Retain changed or referenced User'
      );
      for (const row of [...subject, ...foreign])
        expect(await readReceipt(row)).toEqual([{ row: row.row }]);
    } finally {
      await cleanup(foreign);
      await cleanup(subject);
    }
    try {
      const market = await insertMarket(subject);
      remember(
        'Question',
        await dbWrite
          .insert(questions)
          .values({
            id: await generateSnowflakeId(),
            marketId: market.id,
            questionNumber: Number.parseInt(
              crypto.randomUUID().replaceAll('-', '').slice(0, 7),
              16
            ),
            text: 'Separately acquired foreign-reference control',
            scenarioId: 1705,
            outcome: true,
            rank: 1,
            resolutionDate: new Date(now + 86_400_000),
            updatedAt: new Date(now),
          })
          .returning({
            id: questions.id,
            row: sql<string>`to_jsonb("Question")::text`,
          }),
        foreign
      );
      await expect(cleanup(subject)).rejects.toThrow(
        'Retain changed or referenced Market'
      );
      for (const row of [...subject, ...foreign])
        expect(await readReceipt(row)).toEqual([{ row: row.row }]);
    } finally {
      await cleanup(foreign);
      await cleanup(subject);
    }
  });
});

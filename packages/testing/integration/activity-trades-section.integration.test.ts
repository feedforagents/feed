/** PRD §§3, 9.1, 9.3 / MVP Phase 6: retained trade activity includes actual ledger reasons. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const databaseUrl = process.env.DATABASE_URL ?? '';
const database = new URL(databaseUrl);
const port = database.port || '5432';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.search ||
  database.hash ||
  !(
    (port === '55685' &&
      database.username === 'symbiex' &&
      /^\/feed_pr\d+$/.test(database.pathname)) ||
    (process.env.CI === 'true' &&
      process.env.GITHUB_ACTIONS === 'true' &&
      port === '5432' &&
      database.username === 'postgres' &&
      database.pathname === '/test_db')
  ) ||
  process.env.DIRECT_DATABASE_URL !== databaseUrl ||
  process.env.DATABASE_READ_REPLICA_URL?.trim()
)
  throw new Error('Explicit disposable primary database required');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const server = new URL(base);
if (
  server.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(server.hostname) ||
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash
)
  throw new Error('Disposable loopback HTTP server required');
for (const origin of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (origin && new URL(origin).origin !== server.origin)
    throw new Error('Fixture HTTP origins must match');
const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
type Table =
  | 'User'
  | 'BalanceTransaction'
  | 'Post'
  | 'Comment'
  | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const main: Receipt[] = [],
  controls: Receipt[] = [],
  references: Receipt[] = [];
const fixtures = [main, controls],
  ids = new Map<string, string>(),
  tokens = new Map<string, string>();
const run = randomUUID();
const eventTypes = [
  'pred_buy',
  'pred_sell',
  'perp_open',
  'perp_add_to_position',
  'perp_partial_close',
  'perp_flip_position',
  'perp_close',
  'perp_liquidation',
];
const baseTime = Date.now() - 30 * 24 * 60 * 60_000;
const at = (minute: number) =>
  new Date(baseTime + minute * 60_000).toISOString();
const responseSchema = z.object({
  userId: z.string(),
  activities: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['trade', 'points', 'post', 'comment']),
      timestamp: z.string(),
      data: z.object({
        tradeType: z.string().optional(),
        amount: z.number().optional(),
        postId: z.string().optional(),
        commentId: z.string().optional(),
      }),
    })
  ),
  pagination: z.object({
    limit: z.number().int(),
    count: z.number().int(),
    hasMore: z.boolean(),
  }),
});
function id(label: string) {
  const value = ids.get(label);
  if (!value) throw new Error('Missing acquired fixture ' + label);
  return value;
}
async function fresh() {
  const value = await generateSnowflakeId();
  if (!isValidSnowflakeId(value))
    throw new Error('Invalid generated fixture ID');
  return value;
}
async function acquire(
  tx: postgres.TransactionSql,
  receipts: Receipt[],
  table: Table,
  statement: string,
  values: string[]
) {
  const rows = await tx.unsafe<Physical[]>(
    statement + ` RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of rows) receipts.push({ table, ...row });
  if (rows.length !== 1) throw new Error('Fixture acquisition failed ' + table);
}
async function physical(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const row of rows) {
    const [current] = await control.unsafe<Physical[]>(
      `SELECT id,to_jsonb(t)::text AS canonical FROM "${row.table}" t WHERE id=$1`,
      [row.id]
    );
    if (!current) throw new Error('Acquired row missing');
    result.push({ table: row.table, ...current });
  }
  return result;
}
const guards: Record<Table, string> = {
  BalanceTransaction: '',
  GameOnboarding: '',
  Comment:
    ' AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."parentCommentId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Reaction" x WHERE x."commentId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."commentId"=t.id)',
  Post: ' AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Reaction" x WHERE x."postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Share" x WHERE x."postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PostTag" x WHERE x."postId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."originalPostId"=t.id OR x."commentOnPostId"=t.id OR x."parentCommentId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."postId"=t.id)',
  User: ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"=t.id OR x."grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "BalanceTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PointsTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Position" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PerpPosition" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."userId"=t.id OR x."actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" x WHERE x."userId"=t.id)',
};
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Post', 'Comment'] as const)
      for (const row of rows
        .filter((r) => r.table === table)
        .sort((a, b) => a.id.localeCompare(b.id)))
        await tx.unsafe(`SELECT id FROM "${table}" WHERE id=$1 FOR UPDATE`, [
          row.id,
        ]);
    for (const table of [
      'GameOnboarding',
      'BalanceTransaction',
      'Comment',
      'Post',
      'User',
    ] as const)
      for (const row of rows.filter((r) => r.table === table).reverse()) {
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${guards[table]} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error('Owned cleanup refused ' + table);
      }
  });
  rows.length = 0;
}
async function ledger(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  user: string,
  type: string,
  minute: number
) {
  await acquire(
    tx,
    rows,
    'BalanceTransaction',
    'INSERT INTO "BalanceTransaction"(id,"userId",type,amount,"balanceBefore","balanceAfter",description,"createdAt") VALUES($1,$2,$3,10,100,110,$4,$5::timestamp)',
    [await fresh(), user, type, 'Stored read fixture ' + type, at(minute)]
  );
}
async function call(
  label: string,
  target: string,
  query: string,
  invalid = false
) {
  const token = tokens.get(label);
  if (label !== 'anonymous' && !token)
    throw new Error('Missing normal Steward token');
  return fetch(base + '/api/users/' + target + '/activity?' + query, {
    headers:
      label === 'anonymous'
        ? {}
        : {
            authorization: 'Bearer ' + (invalid ? 'invalid-owned-jwt' : token),
          },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function activity(label: string, type = 'trade', limit = 50) {
  const response = await call(
    label,
    id(label),
    'type=' + type + '&limit=' + limit
  );
  expect(response.status).toBe(200);
  return responseSchema.parse(await response.json());
}
function tradeTypesOf(body: z.infer<typeof responseSchema>) {
  return body.activities
    .filter((a) => a.type === 'trade')
    .map((a) => z.string().parse(a.data.tradeType));
}
beforeAll(async () => {
  const planned = new Map<string, string>();
  for (const label of ['T', 'F', 'M', 'P']) planned.set(label, await fresh());
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    for (const [label, user] of planned)
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","updatedAt")VALUES($1,$2,$3,$4,now())',
        [user, 'a1741_' + user, run + '-' + label, 'Activity ' + label]
      );
    for (const [n, type] of eventTypes.entries())
      await ledger(tx, pending, planned.get('T')!, type, n + 1);
    for (let n = 1; n <= 10; n++)
      await ledger(tx, pending, planned.get('F')!, 'pred_sell', n);
    for (let n = 1; n <= 60; n++) {
      await ledger(tx, pending, planned.get('M')!, 'perp_open', n * 2);
      await ledger(tx, pending, planned.get('M')!, 'deposit', n * 2 + 1);
    }
    const post = await fresh();
    await acquire(
      tx,
      pending,
      'Post',
      'INSERT INTO "Post"(id,"authorId",content,timestamp,"createdAt")VALUES($1,$2,$3,$4::timestamp,$4::timestamp)',
      [post, planned.get('P')!, 'Owned activity guard post', at(1)]
    );
    await acquire(
      tx,
      pending,
      'Comment',
      'INSERT INTO "Comment"(id,"postId","authorId",content,"createdAt","updatedAt")VALUES($1,$2,$3,$4,$5::timestamp,$5::timestamp)',
      [
        await fresh(),
        post,
        planned.get('P')!,
        'Owned activity guard comment',
        at(2),
      ]
    );
  });
  main.push(...pending);
  for (const [label, user] of planned) {
    ids.set(label, user);
    tokens.set(label, await createStewardTestToken(run + '-' + label));
  }
}, 20000);
afterAll(async () => {
  const failures: Error[] = [];
  try {
    await cleanup(references);
  } catch (error) {
    if (error instanceof Error) failures.push(error);
    else throw error;
  }
  for (const rows of fixtures)
    try {
      await cleanup(rows);
    } catch (error) {
      if (error instanceof Error) failures.push(error);
      else throw error;
    }
  await control.end({ timeout: 5 });
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned activity fixture cleanup refused'
    );
}, 20000);
describe('activity trades section', () => {
  it('returns every trade event type the market services write', async () => {
    const before = await physical(main);
    const body = await activity('T');
    expect(tradeTypesOf(body).sort()).toEqual([...eventTypes].sort());
    expect(body.activities).toHaveLength(8);
    expect(
      body.activities.every((a) => a.type === 'trade' && a.data.amount === 10)
    ).toBe(true);
    expect(body.pagination.hasMore).toBe(false);
    expect(await physical(main)).toEqual(before);
  });
  it('returns a full page of the newest trades despite interleaved non-trade rows', async () => {
    const body = await activity('M');
    expect(tradeTypesOf(body)).toHaveLength(50);
    expect(tradeTypesOf(body).every((t) => t === 'perp_open')).toBe(true);
    expect(body.pagination).toEqual({ limit: 50, count: 50, hasMore: true });
    expect(body.activities.map((a) => a.timestamp)).toEqual(
      Array.from({ length: 50 }, (_, i) => at((60 - i) * 2))
    );
  });
  it('includes perp adds and flips in the merged all-types feed', async () => {
    const body = await activity('T', 'all');
    const types = tradeTypesOf(body);
    expect(types).toContain('perp_add_to_position');
    expect(types).toContain('perp_flip_position');
    expect(types).toContain('perp_partial_close');
    expect(types).toHaveLength(8);
  });
  it('keeps the other sections working and other users out', async () => {
    const post = await activity('P', 'post'),
      comment = await activity('P', 'comment');
    expect(post.activities.filter((a) => a.type === 'post')).toHaveLength(1);
    expect(comment.activities.filter((a) => a.type === 'comment')).toHaveLength(
      1
    );
    const forbidden = await call('T', id('F'), 'type=trade&limit=50');
    expect(forbidden.status).toBe(403);
  });
  it('requires normal authentication and validates the existing activity query', async () => {
    expect((await call('anonymous', id('T'), 'type=trade')).status).toBe(401);
    expect((await call('T', id('T'), 'type=trade', true)).status).toBe(401);
    expect((await call('T', id('T'), 'type=trade&limit=0')).status).toBe(400);
    expect((await call('T', id('T'), 'type=unsupported')).status).toBe(400);
  });
  it('does not acquire rolled-back setup and refuses a foreign cascading reference without losing owned ledger rows', async () => {
    const failed: Receipt[] = [];
    await expect(
      control.begin(async (tx) => {
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
          [await fresh(), 'partial1741_' + run]
        );
        await acquire(
          tx,
          failed,
          'User',
          'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
          [id('T'), 'collision1741_' + run]
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    expect(main.some((r) => failed.some((f) => f.id === r.id))).toBe(false);
    for (const row of failed)
      expect(
        await control.unsafe('SELECT id FROM "User" WHERE id=$1', [row.id])
      ).toHaveLength(0);
    const pending: Receipt[] = [],
      user = await fresh();
    await control.begin(async (tx) => {
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
        [user, 'control1741_' + user]
      );
      await ledger(tx, pending, user, 'perp_open', 1);
    });
    controls.push(...pending);
    const dependent: Receipt[] = [];
    await control.begin(async (tx) => {
      await acquire(
        tx,
        dependent,
        'GameOnboarding',
        'INSERT INTO "GameOnboarding"(id,"userId")VALUES($1,$2)',
        [await fresh(), user]
      );
    });
    references.push(...dependent);
    const before = await physical([...controls, ...references]);
    await expect(cleanup(controls)).rejects.toThrow(
      'Owned cleanup refused User'
    );
    expect(await physical([...controls, ...references])).toEqual(before);
    await cleanup(references);
    await cleanup(controls);
  });
});

/** PRD §12 / MVP Phase 5: retained moderation lists count and page existing User targets. */
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
const origin = new URL(base);
if (
  origin.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error('Disposable loopback HTTP server required');
for (const configured of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (configured && new URL(configured).origin !== origin.origin)
    throw new Error('Fixture HTTP origins must match');

const control = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 3,
  onnotice: () => {},
  connection: { statement_timeout: 5000, lock_timeout: 1000, timezone: 'UTC' },
});
type Table = 'User' | 'UserBlock' | 'UserMute' | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const main: Receipt[] = [],
  controls: Receipt[] = [],
  references: Receipt[] = [];
const ids = new Map<string, string>(),
  tokens = new Map<string, string>();
const run = randomUUID();
const tiedAt = new Date(Date.now() - 60_000).toISOString();
const newestAt = new Date(Date.now() - 30_000).toISOString();
const targetSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  isActor: z.boolean(),
});
const pagination = z.object({
  limit: z.number().int(),
  offset: z.number().int(),
  total: z.number().int(),
});
const blocksSchema = z.object({
  blocks: z.array(
    z.object({
      id: z.string(),
      blockerId: z.string(),
      blockedId: z.string(),
      createdAt: z.string(),
      reason: z.string().nullable(),
      blocked: targetSchema,
    })
  ),
  pagination,
});
const mutesSchema = z.object({
  mutes: z.array(
    z.object({
      id: z.string(),
      muterId: z.string(),
      mutedId: z.string(),
      createdAt: z.string(),
      reason: z.string().nullable(),
      muted: targetSchema,
    })
  ),
  pagination,
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
  rows: Receipt[],
  table: Table,
  statement: string,
  values: (string | boolean)[]
) {
  const result = await tx.unsafe<Physical[]>(
    statement + ` RETURNING id,to_jsonb("${table}")::text AS canonical`,
    values
  );
  for (const row of result) rows.push({ table, ...row });
  if (result.length !== 1)
    throw new Error('Fixture acquisition failed ' + table);
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
const userGuard =
  ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"=t.id OR x."grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "BalanceTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PointsTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Position" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PerpPosition" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."userId"=t.id OR x."actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Follow" x WHERE x."followerId"=t.id OR x."followingId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" x WHERE x."userId"=t.id)';
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const row of rows
      .filter((r) => r.table === 'User')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
      await tx.unsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [row.id]);
    for (const table of [
      'GameOnboarding',
      'UserBlock',
      'UserMute',
      'User',
    ] as const)
      for (const row of rows.filter((r) => r.table === table).reverse()) {
        const guard =
          table === 'User'
            ? userGuard +
              ' AND NOT EXISTS(SELECT 1 FROM "UserBlock" x WHERE x."blockerId"=t.id OR x."blockedId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserMute" x WHERE x."muterId"=t.id OR x."mutedId"=t.id)'
            : '';
        const removed = await tx.unsafe<{ id: string }[]>(
          `DELETE FROM "${table}" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${guard} RETURNING id`,
          [row.id, row.canonical]
        );
        if (removed.length !== 1)
          throw new Error('Owned cleanup refused ' + table);
      }
  });
  rows.length = 0;
}
async function call(
  label: string,
  path: string,
  options: { invalid?: boolean; action?: string } = {}
) {
  const token = tokens.get(label);
  if (label !== 'anonymous' && !token)
    throw new Error('Missing normal Steward token');
  return fetch(base + path, {
    method: options.action ? 'POST' : 'GET',
    headers: {
      ...(label === 'anonymous'
        ? {}
        : {
            authorization:
              'Bearer ' + (options.invalid ? 'invalid-owned-jwt' : token),
          }),
      ...(options.action ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.action
      ? { body: JSON.stringify({ action: options.action }) }
      : {}),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function blocks(label = 'viewer', query = '') {
  const response = await call(label, '/api/moderation/blocks' + query);
  expect(response.status).toBe(200);
  return blocksSchema.parse(await response.json());
}
async function mutes(label = 'viewer', query = '') {
  const response = await call(label, '/api/moderation/mutes' + query);
  expect(response.status).toBe(200);
  return mutesSchema.parse(await response.json());
}

beforeAll(async () => {
  const planned = new Map<string, string>();
  for (const label of [
    'viewer',
    'blockA',
    'blockB',
    'blockGhost',
    'muteReal',
    'muteGhost',
    'other',
    'actor',
  ])
    planned.set(label, await fresh());
  const pending: Receipt[] = [];
  const actual = await control.begin(async (tx) => {
    for (const [label, user] of planned)
      await acquire(
        tx,
        pending,
        'User',
        'INSERT INTO "User"(id,username,"stewardId","displayName","isActor","updatedAt")VALUES($1,$2,$3,$4,$5::boolean,now())',
        [
          user,
          'm1733_' + user,
          run + '-' + label,
          'Owned moderation ' + label,
          label === 'actor',
        ]
      );
    const edgeIds = new Map<string, string>();
    for (const [label, table, caller, target, date] of [
      ['blockAEdge', 'UserBlock', 'viewer', 'blockA', tiedAt],
      ['blockBEdge', 'UserBlock', 'viewer', 'blockB', tiedAt],
      ['blockGhostEdge', 'UserBlock', 'viewer', 'blockGhost', newestAt],
      ['muteRealEdge', 'UserMute', 'viewer', 'muteReal', tiedAt],
      ['muteGhostEdge', 'UserMute', 'viewer', 'muteGhost', newestAt],
      ['actorBlock', 'UserBlock', 'other', 'actor', tiedAt],
      ['actorMute', 'UserMute', 'other', 'actor', tiedAt],
    ] as const) {
      const edgeId = await fresh();
      const from = table === 'UserBlock' ? 'blockerId' : 'muterId';
      const to = table === 'UserBlock' ? 'blockedId' : 'mutedId';
      await acquire(
        tx,
        pending,
        table,
        `INSERT INTO "${table}"(id,"${from}","${to}",reason,"createdAt")VALUES($1,$2,$3,$4,$5::timestamp)`,
        [
          edgeId,
          planned.get(caller)!,
          planned.get(target)!,
          'Owned ' + label,
          date,
        ]
      );
      edgeIds.set(label, edgeId);
    }
    // Delete only acquired ghost Users. Their exact acquired moderation edges are
    // intentionally retained; every unrelated physical/logical reference refuses.
    for (const label of ['blockGhost', 'muteGhost']) {
      const user = pending.find(
        (r) => r.table === 'User' && r.id === planned.get(label)
      );
      if (!user) throw new Error('Missing acquired ghost');
      await tx.unsafe('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', [
        user.id,
      ]);
      const ownedBlocks = pending
          .filter((r) => r.table === 'UserBlock')
          .map((r) => r.id),
        ownedMutes = pending
          .filter((r) => r.table === 'UserMute')
          .map((r) => r.id);
      const removed = await tx.unsafe<{ id: string }[]>(
        `DELETE FROM "User" t WHERE id=$1 AND to_jsonb(t)=$2::text::jsonb${userGuard} AND NOT EXISTS(SELECT 1 FROM "UserBlock" x WHERE (x."blockerId"=t.id OR x."blockedId"=t.id) AND NOT(x.id=ANY($3::text[]))) AND NOT EXISTS(SELECT 1 FROM "UserMute" x WHERE (x."muterId"=t.id OR x."mutedId"=t.id) AND NOT(x.id=ANY($4::text[]))) RETURNING id`,
        [user.id, user.canonical, ownedBlocks, ownedMutes]
      );
      if (removed.length !== 1) throw new Error('Owned ghost deletion refused');
      pending.splice(pending.indexOf(user), 1);
    }
    return edgeIds;
  });
  main.push(...pending);
  for (const [label, value] of planned) ids.set(label, value);
  for (const [label, value] of actual) ids.set(label, value);
  for (const label of ['viewer', 'other'])
    tokens.set(label, await createStewardTestToken(run + '-' + label));
}, 20000);
afterAll(async () => {
  const failures: Error[] = [];
  for (const rows of [references, controls, main])
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
      'Owned moderation fixture cleanup refused'
    );
}, 20000);

describe('GET /api/moderation/blocks with an orphaned block', () => {
  it('counts and returns only blocks whose user still exists', async () => {
    const before = await physical(main),
      body = await blocks();
    expect(body.pagination.total).toBe(2);
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks.map((b) => b.blockedId).sort()).toEqual(
      [id('blockA'), id('blockB')].sort()
    );
    expect(body.blocks.every((b) => b.blocked.id === b.blockedId)).toBe(true);
    expect(await physical(main)).toEqual(before);
  });
  it('keeps every real block reachable while paging', async () => {
    const seen: string[] = [];
    for (const offset of [0, 1, 2]) {
      const body = await blocks('viewer', '?limit=1&offset=' + offset);
      expect(body.pagination).toEqual({ limit: 1, offset, total: 2 });
      seen.push(...body.blocks.map((b) => b.id));
    }
    // Both real rows have exactly the same timestamp: raw edge ID breaks ties.
    expect(seen).toEqual([id('blockAEdge'), id('blockBEdge')].sort().reverse());
  });
});
describe('GET /api/moderation/mutes with an orphaned mute', () => {
  it('counts and returns only mutes whose user still exists', async () => {
    const body = await mutes();
    expect(body.pagination.total).toBe(1);
    expect(body.mutes).toHaveLength(1);
    expect(body.mutes[0]?.muted.id).toBe(id('muteReal'));
    expect((await mutes('viewer', '?limit=1&offset=1')).mutes).toEqual([]);
  });
});
it('retains provisioned isActor User targets and isolates the authenticated caller', async () => {
  const blocked = await blocks('other'),
    muted = await mutes('other');
  expect(blocked.pagination.total).toBe(1);
  expect(muted.pagination.total).toBe(1);
  expect(blocked.blocks.map((b) => [b.blockedId, b.blocked.isActor])).toEqual([
    [id('actor'), true],
  ]);
  expect(muted.mutes.map((m) => [m.mutedId, m.muted.isActor])).toEqual([
    [id('actor'), true],
  ]);
  for (const endpoint of ['/api/moderation/blocks', '/api/moderation/mutes']) {
    expect((await call('anonymous', endpoint)).status).toBe(401);
    expect((await call('viewer', endpoint, { invalid: true })).status).toBe(
      401
    );
    expect((await call('viewer', endpoint + '?limit=0')).status).toBe(400);
  }
});
it('undoes the caller’s own block and mute through the existing normal HTTP actions', async () => {
  for (const [table, label, path, action] of [
    ['UserBlock', 'actorBlock', 'block', 'unblock'],
    ['UserMute', 'actorMute', 'mute', 'unmute'],
  ] as const) {
    const response = await call(
      'other',
      '/api/users/' + id('actor') + '/' + path,
      { action }
    );
    // Capture the attributable deletion before semantic assertions, so failed
    // assertions cannot leave a stale cleanup receipt for a deleted owned row.
    const receipt = main.find((r) => r.table === table && r.id === id(label));
    if (!receipt) throw new Error('Missing acquired action edge');
    const remaining = await control.unsafe(
      `SELECT id FROM "${table}" WHERE id=$1`,
      [receipt.id]
    );
    if (!remaining.length) main.splice(main.indexOf(receipt), 1);
    expect(response.status).toBe(200);
    expect(
      z.object({ success: z.literal(true) }).parse(await response.json())
        .success
    ).toBe(true);
    expect(remaining).toHaveLength(0);
  }
  expect((await blocks('other')).blocks).toEqual([]);
  expect((await mutes('other')).mutes).toEqual([]);
  expect((await blocks()).pagination.total).toBe(2);
  expect((await mutes()).pagination.total).toBe(1);
});
it('does not acquire rolled-back setup and refuses foreign cascading rows atomically', async () => {
  const failed: Receipt[] = [];
  await expect(
    control.begin(async (tx) => {
      await acquire(
        tx,
        failed,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
        [await fresh(), 'partial1733_' + run]
      );
      await acquire(
        tx,
        failed,
        'User',
        'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
        [id('viewer'), 'collision1733_' + run]
      );
    })
  ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
  for (const row of failed)
    expect(
      await control.unsafe('SELECT id FROM "User" WHERE id=$1', [row.id])
    ).toHaveLength(0);
  expect(main.some((r) => failed.some((f) => f.id === r.id))).toBe(false);
  const pending: Receipt[] = [],
    user = await fresh();
  await control.begin(async (tx) => {
    await acquire(
      tx,
      pending,
      'User',
      'INSERT INTO "User"(id,username,"updatedAt")VALUES($1,$2,now())',
      [user, 'control1733_' + user]
    );
    await acquire(
      tx,
      pending,
      'UserBlock',
      'INSERT INTO "UserBlock"(id,"blockerId","blockedId")VALUES($1,$2,$3)',
      [await fresh(), user, id('blockA')]
    );
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
  await expect(cleanup(controls)).rejects.toThrow('Owned cleanup refused User');
  expect(await physical([...controls, ...references])).toEqual(before);
  await cleanup(references);
  await cleanup(controls);
});

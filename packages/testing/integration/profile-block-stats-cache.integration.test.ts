/** PRD §12 / MVP Phase 5: a block removes both profile follow counts immediately. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

type Table = 'User' | 'Follow' | 'UserBlock' | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const owned: Receipt[] = [],
  controls: Receipt[] = [],
  safety: Receipt[] = [];
const receiptPath = join(
  mkdtempSync(join(tmpdir(), 'feed-profile-block-')),
  'receipts.jsonl'
);
function record(event: string, rows: Receipt[]) {
  appendFileSync(receiptPath, JSON.stringify({ event, rows }) + '\n', {
    mode: 0o600,
  });
}
const databaseURL = process.env.DATABASE_URL || '';
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
if (!URL.canParse(databaseURL) || !URL.canParse(base))
  throw new Error('Explicit disposable profile-block targets required');
const database = new URL(databaseURL),
  endpoint = new URL(base);
const local =
  ['localhost', '127.0.0.1'].includes(database.hostname) &&
  database.port === '55685' &&
  database.username === 'symbiex' &&
  /^\/feed_pr\d+$/.test(database.pathname);
const ci =
  process.env.CI === 'true' &&
  process.env.GITHUB_ACTIONS === 'true' &&
  ['localhost', '127.0.0.1'].includes(database.hostname) &&
  database.port === '5432' &&
  database.username === 'postgres' &&
  database.pathname === '/test_db';
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  database.search ||
  database.hash ||
  !(local || ci) ||
  process.env.DIRECT_DATABASE_URL !== databaseURL ||
  process.env.DATABASE_READ_REPLICA_URL?.trim() ||
  process.env.POSTGRES_URL?.trim()
)
  throw new Error('Disposable primary required');
if (
  endpoint.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Disposable loopback HTTP target required');
for (const url of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
  if (url && (!URL.canParse(url) || new URL(url).origin !== endpoint.origin))
    throw new Error('Fixture HTTP origins must agree');
const control = postgres(databaseURL, {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
  onnotice: () => {},
});
const Profile = z.object({
  user: z.object({
    id: z.string(),
    stats: z.object({ followers: z.number(), following: z.number() }),
  }),
});
const Block = z.object({
  success: z.literal(true),
  block: z.object({
    id: z.string(),
    blockerId: z.string(),
    blockedId: z.string(),
  }),
});
let blocker = '',
  target = '',
  token = '';
async function fresh() {
  const id = await generateSnowflakeId();
  assert.ok(isValidSnowflakeId(id));
  return id;
}
async function acquire(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  table: Table,
  sql: string,
  values: string[]
) {
  const result = await tx.unsafe<Physical[]>(
    sql + ' RETURNING id,to_jsonb("' + table + '")::text AS canonical',
    values
  );
  rows.push(...result.map((row) => ({ table, ...row })));
  record(
    'pending INSERT RETURNING',
    result.map((row) => ({ table, ...row }))
  );
  assert.equal(result.length, 1);
}
async function insertUser(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  id: string,
  username = 'f76_' + id,
  stewardId = 'profile-block-' + id
) {
  await acquire(
    tx,
    rows,
    'User',
    'INSERT INTO "User"(id,username,"stewardId","updatedAt") VALUES($1,$2,$3,now())',
    [id, username, stewardId]
  );
}
async function snapshot(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const table of [
    'User',
    'Follow',
    'UserBlock',
    'GameOnboarding',
  ] as const) {
    const ids = rows.filter((row) => row.table === table).map((row) => row.id);
    if (!ids.length) continue;
    const actual = await control.unsafe<Physical[]>(
      'SELECT id,to_jsonb(t)::text AS canonical FROM "' +
        table +
        '" t WHERE id IN(SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id',
      [JSON.stringify(ids)]
    );
    assert.equal(actual.length, ids.length);
    result.push(...actual.map((row) => ({ table, ...row })));
  }
  return result;
}
const userGuard =
  ' AND NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"=t.id OR x."grantedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"=t.id) AND NOT EXISTS(SELECT 1 FROM "BalanceTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PointsTransaction" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."authorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Position" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "PerpPosition" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."userId"=t.id OR x."actorId"=t.id) AND NOT EXISTS(SELECT 1 FROM "UserApiKey" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "Follow" x WHERE x."followerId"=t.id OR x."followingId"=t.id) AND NOT EXISTS(SELECT 1 FROM "GroupMember" x WHERE x."userId"=t.id) AND NOT EXISTS(SELECT 1 FROM "ChatParticipant" x WHERE x."userId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserActorFollow" f WHERE f."userId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Reaction" f WHERE f."userId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "AdminRole" f WHERE f."userId"=t.id OR f."grantedBy"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserBlock" f WHERE f."blockerId"=t.id OR f."blockedId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserMute" f WHERE f."muterId"=t.id OR f."mutedId"=t.id)';

async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    const userIds = rows
      .filter((row) => row.table === 'User')
      .map((row) => row.id);
    if (userIds.length)
      await tx.unsafe(
        'SELECT id FROM "User" WHERE id IN(SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE',
        [JSON.stringify(userIds)]
      );
    for (const table of [
      'Follow',
      'UserBlock',
      'GameOnboarding',
      'User',
    ] as const) {
      const expected = rows.filter((row) => row.table === table);
      if (!expected.length) continue;
      const removed = await tx.unsafe<{ id: string }[]>(
        'DELETE FROM "' +
          table +
          "\" t USING jsonb_array_elements($1::text::jsonb) r WHERE t.id=r->>'id' AND to_jsonb(t)=(r->>'canonical')::jsonb" +
          (table === 'User' ? userGuard : '') +
          ' RETURNING t.id',
        [JSON.stringify(expected)]
      );
      assert.equal(
        removed.length,
        expected.length,
        'Owned profile-block cleanup refused ' + table
      );
      assert.deepEqual(
        removed.map((row) => row.id).sort(),
        expected.map((row) => row.id).sort()
      );
    }
  });
  record('committed cleanup', rows);
  rows.length = 0;
}
async function releaseControl(table: Table) {
  const selected = controls.filter((row) => row.table === table);
  await cleanup(selected);
  for (let i = controls.length - 1; i >= 0; i--)
    if (controls[i]?.table === table) controls.splice(i, 1);
}
async function request(path: string, bearer = '', body?: { action: string }) {
  return fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function profile(id: string) {
  const response = await request('/api/users/' + id + '/profile');
  expect(response.status).toBe(200);
  const user = Profile.parse(await response.json()).user;
  expect(user.id).toBe(id);
  return user.stats;
}
async function followers(id: string) {
  const response = await request('/api/users/' + id + '/followers');
  expect(response.status).toBe(200);
  return z.object({ count: z.number() }).parse(await response.json()).count;
}
beforeAll(async () => {
  const [identity] = await control.unsafe<
    {
      database: string;
      role: string;
      session: string;
      host: string;
      port: number;
      primary: boolean;
    }[]
  >(
    'SELECT current_database() AS database,current_user AS role,session_user AS session,host(inet_server_addr()) AS host,inet_server_port() AS port,NOT pg_is_in_recovery() AS primary'
  );
  assert.ok(identity);
  assert.equal(identity.database, database.pathname.slice(1));
  assert.equal(identity.role, database.username);
  assert.equal(identity.session, database.username);
  assert.equal(identity.port, Number(database.port));
  assert.equal(identity.primary, true);
  assert.ok(
    ['127.0.0.1', '::1'].includes(identity.host) ||
      (ci &&
        !!process.env.FEED_TEST_POSTGRES_ADDRESS &&
        identity.host === process.env.FEED_TEST_POSTGRES_ADDRESS)
  );
  expect((await request('/api/health')).status).toBe(200);
  blocker = await fresh();
  target = await fresh();
  token = await createStewardTestToken('profile-block-' + blocker);
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    await insertUser(tx, pending, blocker);
    await insertUser(tx, pending, target);
    await acquire(
      tx,
      pending,
      'Follow',
      'INSERT INTO "Follow"(id,"followerId","followingId") VALUES($1,$2,$3)',
      [await fresh(), blocker, target]
    );
    await acquire(
      tx,
      pending,
      'Follow',
      'INSERT INTO "Follow"(id,"followerId","followingId") VALUES($1,$2,$3)',
      [await fresh(), target, blocker]
    );
  });
  owned.push(...pending);
  record('committed setup', owned);
}, 30000);
afterAll(async () => {
  const failures: Error[] = [];
  for (const rows of [controls, safety, owned]) {
    try {
      await cleanup(rows);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
    }
  }
  await control.end({ timeout: 5 });
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned profile-block cleanup refused; receipts: ' + receiptPath
    );
}, 20000);

describe('profile header counts after a block', () => {
  it('refuses missing and invalid authentication without changing the owned profiles', async () => {
    const before = await snapshot(owned);
    for (const bearer of ['', 'invalid-profile-block-token'])
      expect(
        (
          await request('/api/users/' + target + '/block', bearer, {
            action: 'block',
          })
        ).status
      ).toBe(401);
    expect(await snapshot(owned)).toEqual(before);
    expect(
      await control.unsafe(
        'SELECT id FROM "UserBlock" WHERE "blockerId"=$1 AND "blockedId"=$2',
        [blocker, target]
      )
    ).toHaveLength(0);
  });
  it('stops counting the removed follows on both profiles immediately', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await profile(blocker)).toEqual({ followers: 1, following: 1 });
      expect(await profile(target)).toEqual({ followers: 1, following: 1 });
    }
    expect(await followers(target)).toBe(1);
    expect(
      await control.unsafe(
        'SELECT id FROM "UserBlock" WHERE "blockerId"=$1 AND "blockedId"=$2',
        [blocker, target]
      )
    ).toHaveLength(0);
    const response = await request('/api/users/' + target + '/block', token, {
      action: 'block',
    });
    expect(response.status).toBe(200);
    const block = Block.parse(await response.json()).block;
    assert.equal(block.blockerId, blocker);
    assert.equal(block.blockedId, target);
    // This row is produced by the successful HTTP block, not by fixture INSERT.
    // Bind its returned ID to the initially absent, freshly owned pair.
    const acquired = await control.unsafe<Physical[]>(
      'SELECT id,to_jsonb(t)::text AS canonical FROM "UserBlock" t WHERE id=$1 AND "blockerId"=$2 AND "blockedId"=$3',
      [block.id, blocker, target]
    );
    assert.equal(acquired.length, 1);
    owned.push(
      ...acquired.map((row) => ({ table: 'UserBlock' as const, ...row }))
    );
    record(
      'HTTP-produced block acquisition',
      owned.filter((row) => row.table === 'UserBlock')
    );
    const consumed = owned.filter((row) => row.table === 'Follow');
    expect(
      await control.unsafe(
        'SELECT id FROM "Follow" WHERE id IN(SELECT jsonb_array_elements_text($1::text::jsonb))',
        [JSON.stringify(consumed.map((row) => row.id))]
      )
    ).toHaveLength(0);
    record('follows deleted by successful block', consumed);
    for (let i = owned.length - 1; i >= 0; i--)
      if (owned[i]?.table === 'Follow') owned.splice(i, 1);
    expect(await followers(target)).toBe(0);
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await profile(blocker)).toEqual({ followers: 0, following: 0 });
      expect(await profile(target)).toEqual({ followers: 0, following: 0 });
    }
    expect(await snapshot(owned.filter((row) => row.table === 'User'))).toEqual(
      owned
        .filter((row) => row.table === 'User')
        .sort((a, b) => a.id.localeCompare(b.id))
    );
  }, 30000);
});
describe('fixture ownership', () => {
  it('cleanup after failed setup never deletes rows the fixture did not create', async () => {
    const before = await snapshot(owned),
      partial = await fresh(),
      victim = await fresh(),
      context = await fresh();
    let pending: Receipt[] = [];
    await control.begin(async (tx) => {
      await insertUser(tx, pending, victim);
    });
    safety.push(...pending);
    record('committed safety fixture', safety);
    pending = [];
    await expect(
      control.begin(async (tx) => {
        await insertUser(tx, pending, partial);
        await insertUser(
          tx,
          pending,
          victim,
          'collision_' + partial,
          'collision-subject-' + partial
        );
      })
    ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
    expect(
      await control.unsafe('SELECT id FROM "User" WHERE id=$1', [partial])
    ).toHaveLength(0);
    // Pending RETURNING rows from the rolled-back transaction are never adopted.
    expect(await snapshot(owned)).toEqual(before);
    pending = [];
    await control.begin(async (tx) => {
      await insertUser(tx, pending, context);
      await acquire(
        tx,
        pending,
        'Follow',
        'INSERT INTO "Follow"(id,"followerId","followingId") VALUES($1,$2,$3)',
        [await fresh(), context, victim]
      );
      await acquire(
        tx,
        pending,
        'GameOnboarding',
        'INSERT INTO "GameOnboarding"(id,"userId") VALUES($1,$2)',
        [await fresh(), victim]
      );
    });
    controls.push(...pending);
    record('committed foreign controls', controls);
    const original = await snapshot(safety);
    for (const table of ['Follow', 'GameOnboarding'] as const) {
      const external = await snapshot(controls);
      await expect(cleanup(safety)).rejects.toThrow(
        'Owned profile-block cleanup refused User'
      );
      expect(await snapshot(safety)).toEqual(original);
      expect(await snapshot(controls)).toEqual(external);
      await releaseControl(table);
    }
    await cleanup(safety);
    expect(await snapshot(owned)).toEqual(before);
    expect(await snapshot(controls)).toEqual(controls);
  }, 30000);
});

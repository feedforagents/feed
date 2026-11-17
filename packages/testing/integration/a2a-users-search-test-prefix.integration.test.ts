/** PRD §§8.1/8.2/12, MVP3/5 compatibility; A2A still retires in Phase1. Real existing key-auth HTTP. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateApiKey, hashApiKey } from '@feed/api';
import { generateSnowflakeId, isValidSnowflakeId } from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const fixtures = new Map<string, string>();

type Table = 'User' | 'UserApiKey' | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
type UserSeed = {
  id: string;
  username?: string;
  displayName?: string;
  isActor?: boolean;
  isAgent?: boolean;
  isBanned?: boolean;
  isTest?: boolean;
  bannedAt?: string;
  updatedAt?: string;
};
const owned: Receipt[] = [],
  controls: Receipt[] = [],
  safety: Receipt[] = [];
const receiptPath = join(
  mkdtempSync(join(tmpdir(), 'feed-a2a-users-search-')),
  'receipts.jsonl'
);
function record(event: string, rows: Receipt[]) {
  appendFileSync(receiptPath, JSON.stringify({ event, rows }) + '\n', {
    mode: 0o600,
  });
}
const databaseURL = process.env.DATABASE_URL || '';
if (!URL.canParse(databaseURL) || !URL.canParse(baseUrl))
  throw new Error('Explicit disposable tool-search targets required');
const database = new URL(databaseURL),
  endpoint = new URL(baseUrl);
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

async function verifyTarget() {
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
}
async function fresh() {
  const id = await generateSnowflakeId();
  assert.ok(isValidSnowflakeId(id));
  return id;
}
async function acquire(
  tx: postgres.TransactionSql,
  pending: Receipt[],
  table: Table,
  statement: string,
  values: string[]
) {
  const rows = await tx.unsafe<Physical[]>(
    statement + ' RETURNING id,to_jsonb("' + table + '")::text AS canonical',
    values
  );
  assert.equal(rows.length, 1);
  pending.push(...rows.map((row) => ({ table, ...row })));
  record(
    'pending INSERT RETURNING; not ownership until commit',
    rows.map((row) => ({ table, ...row }))
  );
}
async function insertUser(
  tx: postgres.TransactionSql,
  pending: Receipt[],
  seed: UserSeed
) {
  // JSON carries native booleans and explicit ISO timestamps. The single driver
  // parameter is text, so no Boolean or Date serializer coercion is involved.
  await acquire(
    tx,
    pending,
    'User',
    'INSERT INTO "User"(id,username,"displayName","isActor","isAgent","isBanned","isTest","bannedAt","updatedAt") SELECT x.id,x.username,x."displayName",COALESCE(x."isActor",false),COALESCE(x."isAgent",false),COALESCE(x."isBanned",false),COALESCE(x."isTest",false),x."bannedAt",x."updatedAt" FROM jsonb_to_record($1::text::jsonb) AS x(id text,username text,"displayName" text,"isActor" boolean,"isAgent" boolean,"isBanned" boolean,"isTest" boolean,"bannedAt" timestamp,"updatedAt" timestamp)',
    [
      JSON.stringify({
        ...seed,
        updatedAt: seed.updatedAt ?? new Date().toISOString(),
      }),
    ]
  );
}
async function snapshot(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const table of ['User', 'UserApiKey', 'GameOnboarding'] as const) {
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
  ' AND NOT EXISTS(SELECT 1 FROM "UserMute" f WHERE f."muterId"=t.id OR f."mutedId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserSession" x WHERE x."userId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserActivityLog" x WHERE x."userId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "UserAgentConfig" x WHERE x."userId"=t.id)';

async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  const deleted: Receipt[] = [];
  await control.begin(async (tx) => {
    const userIds = rows
      .filter((row) => row.table === 'User')
      .map((row) => row.id);
    if (userIds.length)
      await tx.unsafe(
        'SELECT id FROM "User" WHERE id IN(SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE',
        [JSON.stringify(userIds)]
      );
    for (const table of ['UserApiKey', 'GameOnboarding', 'User'] as const) {
      const expected = rows.filter((row) => row.table === table);
      if (!expected.length) continue;
      // Only a successfully acquired API key may receive auth's lastUsedAt
      // update. Every other physical field remains exact; never restore it.
      const exact =
        table === 'UserApiKey'
          ? "(to_jsonb(t)-'lastUsedAt')=((r->>'canonical')::jsonb-'lastUsedAt') AND (to_jsonb(t)->'lastUsedAt'=(r->>'canonical')::jsonb->'lastUsedAt' OR ((r->>'canonical')::jsonb->'lastUsedAt'='null'::jsonb AND t.\"lastUsedAt\">=t.\"createdAt\"-interval '1 second' AND t.\"lastUsedAt\"<=clock_timestamp()+interval '1 second'))"
          : "to_jsonb(t)=(r->>'canonical')::jsonb";
      const removed = await tx.unsafe<Physical[]>(
        'DELETE FROM "' +
          table +
          "\" t USING jsonb_array_elements($1::text::jsonb) r WHERE t.id=r->>'id' AND " +
          exact +
          (table === 'User' ? userGuard : '') +
          ' RETURNING t.id,to_jsonb(t)::text AS canonical',
        [JSON.stringify(expected)]
      );
      assert.equal(
        removed.length,
        expected.length,
        'Owned tool-search cleanup refused ' + table
      );
      assert.deepEqual(
        removed.map((row) => row.id).sort(),
        expected.map((row) => row.id).sort()
      );
      deleted.push(...removed.map((row) => ({ table, ...row })));
    }
  });
  record(
    'committed exact cleanup; allowed key auth timestamp recorded, not restored',
    deleted
  );
  rows.length = 0;
}
async function closeOwned() {
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
      'Owned tool-search cleanup refused; receipts: ' + receiptPath
    );
}
async function ownershipControl() {
  const mainUsers = owned.filter((row) => row.table === 'User');
  const before = await snapshot(mainUsers);
  const victim = await fresh(),
    partial = await fresh();
  let pending: Receipt[] = [];
  await control.begin(async (tx) => {
    await insertUser(tx, pending, { id: victim, username: 'owner_' + victim });
  });
  safety.push(...pending);
  record('committed safety User', safety);
  pending = [];
  await expect(
    control.begin(async (tx) => {
      await insertUser(tx, pending, {
        id: partial,
        username: 'partial_' + partial,
      });
      await insertUser(tx, pending, {
        id: victim,
        username: 'collision_' + partial,
      });
    })
  ).rejects.toMatchObject({ code: '23505', constraint_name: 'User_pkey' });
  expect(
    await control.unsafe('SELECT id FROM "User" WHERE id=$1', [partial])
  ).toHaveLength(0);
  // Pending rows from the failed transaction never become cleanup ownership.
  expect(await snapshot(mainUsers)).toEqual(before);
  pending = [];
  await control.begin(async (tx) => {
    await acquire(
      tx,
      pending,
      'GameOnboarding',
      'INSERT INTO "GameOnboarding"(id,"userId") VALUES($1,$2)',
      [await fresh(), victim]
    );
  });
  controls.push(...pending);
  record('committed separately owned foreign User child', controls);
  const original = await snapshot(safety),
    external = await snapshot(controls);
  await expect(cleanup(safety)).rejects.toThrow(
    'Owned tool-search cleanup refused User'
  );
  expect(await snapshot(safety)).toEqual(original);
  expect(await snapshot(controls)).toEqual(external);
  await cleanup(controls);
  await cleanup(safety);
  expect(await snapshot(mainUsers)).toEqual(before);
}
const entrySchema = z.strictObject({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  reputationPoints: z.number(),
  bio: z.string().nullable(),
  isAgent: z.boolean(),
});
const responseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object({
    kind: z.literal('task'),
    contextId: z.string(),
    status: z.object({ state: z.literal('completed') }),
    artifacts: z.array(
      z.object({
        parts: z.array(
          z.object({
            kind: z.literal('data'),
            data: z.object({ users: z.array(entrySchema) }),
          })
        ),
      })
    ),
  }),
});
let rawKey = '';
let token = '';
let usernameToken = '';
let displayToken = '';
const eligible: string[] = [];

function id(label: string) {
  const value = fixtures.get(label);
  assert.ok(value, `Missing owned fixture ${label}`);
  return value;
}
async function send(query: string, limit?: number) {
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}/api/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Feed-Api-Key': rawKey,
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'user',
          parts: [
            {
              kind: 'data',
              data: { operation: 'users.search', params: { query, limit } },
            },
          ],
        },
        configuration: { blocking: true },
      },
    }),
  });
  return { response, requestId };
}
async function search(query = token, limit?: number) {
  const { response, requestId } = await send(query, limit);
  expect(response.status).toBe(200);
  const payload = responseSchema.parse(await response.json());
  expect(payload.id).toBe(requestId);
  expect(payload.result.contextId).toBe(id('caller'));
  const parts = payload.result.artifacts.flatMap((artifact) => artifact.parts);
  expect(parts).toHaveLength(1);
  return parts[0]!.data.users;
}

beforeAll(async () => {
  await verifyTarget();
  token = randomUUID().replaceAll('-', '').slice(0, 12);
  usernameToken = `${token}u`;
  displayToken = `${token}d`;
  const proposed = new Map<string, string>();
  proposed.set('prefixname', `test-${await fresh()}`);
  proposed.set('prefixdisplay', `test-${await fresh()}`);
  for (const label of ['flagtest', 'banned', 'normaluser', 'caller'])
    proposed.set(label, await fresh());
  function planned(label: string): string {
    const value = proposed.get(label);
    assert.ok(value);
    return value;
  }
  const seeds: Array<{ label: string; seed: UserSeed }> = [
    {
      label: 'caller',
      seed: {
        id: planned('caller'),
        username: `plain_${planned('caller')}`,
        displayName: 'Population fixture caller',
      },
    },
    {
      label: 'prefixname',
      seed: {
        id: planned('prefixname'),
        username: `${usernameToken}_prefixname`,
        displayName: 'Prefix fixture name',
        isTest: false,
      },
    },
    {
      label: 'prefixdisplay',
      seed: {
        id: planned('prefixdisplay'),
        username: `plain_${planned('prefixdisplay')}`,
        displayName: `${displayToken} prefixdisplay`,
        isTest: false,
      },
    },
    {
      label: 'flagtest',
      seed: {
        id: planned('flagtest'),
        username: `${usernameToken}_flagtest`,
        displayName: 'Flag fixture',
        isTest: true,
      },
    },
    {
      label: 'banned',
      seed: {
        id: planned('banned'),
        username: `${usernameToken}_banned`,
        displayName: 'Banned fixture',
        isBanned: true,
      },
    },
    {
      label: 'normaluser',
      seed: {
        id: planned('normaluser'),
        username: `${usernameToken}_normaluser`,
        displayName: `${displayToken} normaluser`,
      },
    },
  ];
  const key = generateApiKey(),
    keyId = await fresh();
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    for (const { seed } of seeds) await insertUser(tx, pending, seed);
    await acquire(
      tx,
      pending,
      'UserApiKey',
      'INSERT INTO "UserApiKey"(id,"userId","keyHash",name,"expiresAt","revokedAt") VALUES($1,$2,$3,$4,NULL,NULL)',
      [
        keyId,
        planned('caller'),
        hashApiKey(key),
        'Owned users.search prefix regression',
      ]
    );
  });
  owned.push(...pending);
  record('committed Users and per-user key acquisition', pending);
  for (const { label, seed } of seeds) {
    const acquired = pending.find(
      (row) => row.table === 'User' && row.id === seed.id
    );
    assert.ok(acquired);
    fixtures.set(label, acquired.id);
  }
  assert.ok(
    pending.some((row) => row.table === 'UserApiKey' && row.id === keyId)
  );
  rawKey = key;
  eligible.push(id('normaluser'));
}, 30000);
afterAll(closeOwned, 20000);
test('excludes test accounts identified by the test- id prefix alone', async () => {
  const found = await search();
  expect(found.map((row) => row.id).sort()).toEqual([...eligible].sort());
});

test('applies the prefix exclusion to username and display-name matches', async () => {
  expect((await search(usernameToken)).map((row) => row.id)).toEqual([
    id('normaluser'),
  ]);
  expect((await search(displayToken)).map((row) => row.id)).toEqual([
    id('normaluser'),
  ]);
});

test('fills a small limit with eligible rows only', async () => {
  const found = await search(token, 1);
  expect(found).toHaveLength(1);
  expect(eligible).toContain(found[0]!.id);
});

test(
  'refuses partial A2A search setup ownership and a foreign User child atomically',
  ownershipControl,
  30000
);

/**
 * Existing feed paging under PRD §3/§12. MVP Phase 1 still retires A2A.
 * Stable-data offset continuation only: no new web/MCP visibility policy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '@feed/api';
import {
  generateSnowflakeId,
  isValidSnowflakeId,
  type JsonValue,
} from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';

type Table = 'User' | 'Post' | 'UserApiKey' | 'Reaction' | 'GameOnboarding';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const owned: Receipt[] = [],
  controls: Receipt[] = [],
  setupPending: Receipt[] = [];
const fixtureIds: string[] = [];
const databaseURL = process.env.DATABASE_URL || '';
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
if (!URL.canParse(databaseURL) || !URL.canParse(base))
  throw new Error('Explicit disposable A2A feed targets required');
const database = new URL(databaseURL);
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
const endpoint = new URL(base);
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
const FeedData = z.object({
  posts: z.array(z.object({ id: z.string(), timestamp: z.string() })),
});
const Envelope = z.object({
  result: z.object({
    contextId: z.string(),
    status: z.object({
      state: z.string(),
      message: z
        .object({
          parts: z.array(z.object({ text: z.string().optional() })),
        })
        .optional(),
    }),
    artifacts: z
      .array(
        z.object({
          parts: z.array(
            z.object({
              kind: z.string(),
              data: FeedData.optional(),
            })
          ),
        })
      )
      .optional(),
  }),
});
let caller = '',
  author = '',
  apiKey = '';
let firstKeyUse = new Date();
async function fresh() {
  const id = await generateSnowflakeId();
  assert.ok(isValidSnowflakeId(id));
  return id;
}
async function acquire(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  table: Table,
  statement: string,
  values: string[],
  count = 1
) {
  const result = await tx.unsafe<Physical[]>(
    statement + ' RETURNING id,to_jsonb("' + table + '")::text AS canonical',
    values
  );
  for (const row of result) rows.push({ table, ...row });
  assert.equal(result.length, count);
}
async function insertUser(
  tx: postgres.TransactionSql,
  rows: Receipt[],
  id: string,
  username = 'f27_' + id
) {
  await acquire(
    tx,
    rows,
    'User',
    'INSERT INTO "User"(id,username,"updatedAt") VALUES($1,$2,now())',
    [id, username]
  );
}
async function physical(rows: Receipt[]) {
  const result: Receipt[] = [];
  for (const table of [
    'User',
    'Post',
    'UserApiKey',
    'Reaction',
    'GameOnboarding',
  ] as const) {
    const ids = rows.filter((r) => r.table === table).map((r) => r.id);
    if (!ids.length) continue;
    // Only the authenticated key's existing lastUsedAt side effect is excluded.
    const projection =
      table === 'UserApiKey' ? "(to_jsonb(t)-'lastUsedAt')" : 'to_jsonb(t)';
    const actual = await control.unsafe<Physical[]>(
      'SELECT id,' +
        projection +
        '::text AS canonical FROM "' +
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
const postGuard =
  ' AND NOT EXISTS(SELECT 1 FROM "Reaction" f WHERE f."postId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Comment" f WHERE f."postId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Share" f WHERE f."postId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "PostTag" f WHERE f."postId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Notification" f WHERE f."postId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Post" f WHERE f.id<>t.id AND(f."originalPostId"=t.id OR f."commentOnPostId"=t.id OR f."parentCommentId"=t.id))';
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Post'] as const) {
      const ids = rows.filter((r) => r.table === table).map((r) => r.id);
      if (ids.length)
        await tx.unsafe(
          'SELECT id FROM "' +
            table +
            '" WHERE id IN(SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE',
          [JSON.stringify(ids)]
        );
    }
    for (const table of [
      'Reaction',
      'GameOnboarding',
      'UserApiKey',
      'Post',
      'User',
    ] as const) {
      const expected = rows.filter((r) => r.table === table);
      if (!expected.length) continue;
      // Do not restore a pre-authentication audit timestamp. Permit only this
      // owned key's bounded lastUsedAt write; every other physical field is exact.
      const exact =
        table === 'UserApiKey'
          ? "(to_jsonb(t)-'lastUsedAt')=((r->>'canonical')::jsonb-'lastUsedAt') AND " +
            '(t."lastUsedAt" IS NULL OR t."lastUsedAt" BETWEEN $2::timestamp AND (clock_timestamp() AT TIME ZONE \'UTC\'))'
          : "to_jsonb(t)=(r->>'canonical')::jsonb";
      const guard =
        table === 'Post' ? postGuard : table === 'User' ? userGuard : '';
      const removed = await tx.unsafe<{ id: string }[]>(
        'DELETE FROM "' +
          table +
          "\" t USING jsonb_array_elements($1::text::jsonb) r WHERE t.id=r->>'id' AND " +
          exact +
          guard +
          ' RETURNING t.id',
        table === 'UserApiKey'
          ? [JSON.stringify(expected), firstKeyUse.toISOString()]
          : [JSON.stringify(expected)]
      );
      assert.equal(
        removed.length,
        expected.length,
        'Owned A2A feed cleanup refused ' + table
      );
      assert.deepEqual(
        removed.map((r) => r.id).sort(),
        expected.map((r) => r.id).sort()
      );
    }
  });
  rows.length = 0;
}
async function releaseControls(table: Table) {
  const rows = controls.filter((r) => r.table === table);
  await cleanup([...rows]);
  for (const row of rows) {
    const index = controls.indexOf(row);
    assert.ok(index >= 0);
    controls.splice(index, 1);
  }
}
async function orderedIds() {
  return (
    await control.unsafe<{ id: string }[]>(
      'SELECT p.id FROM "Post" p WHERE p."deletedAt" IS NULL AND p."authorId" NOT LIKE \'test-%\' AND NOT EXISTS(SELECT 1 FROM "User" u WHERE u.id=p."authorId" AND u."isTest"=true) ORDER BY p."timestamp" DESC,p.id DESC'
    )
  ).map((row) => row.id);
}
async function request(
  params: Record<string, JsonValue>,
  key = apiKey,
  contextId = caller
) {
  return fetch(base + '/api/a2a', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'X-Feed-Api-Key': key } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'message/send',
      params: {
        contextId,
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          role: 'user',
          contextId,
          parts: [
            { kind: 'data', data: { operation: 'social.get_feed', params } },
          ],
        },
        configuration: { blocking: true },
      },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function feed(
  params: Record<string, JsonValue> = {},
  contextId = caller
) {
  const response = await request(params, apiKey, contextId);
  expect(response.status).toBe(200);
  const task = Envelope.parse(await response.json()).result;
  expect(task.contextId).toBe(caller);
  expect(task.status.state).toBe('completed');
  const data = task.artifacts
    ?.flatMap((a) => a.parts)
    .find((p) => p.kind === 'data')?.data;
  assert.ok(data);
  return data.posts;
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
    'SELECT current_database() AS database,current_user AS role,session_user AS session,' +
      'host(inet_server_addr()) AS host,inet_server_port() AS port,NOT pg_is_in_recovery() AS primary'
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
  expect(
    (
      await fetch(base + '/api/health', {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
    ).status
  ).toBe(200);
  const rawKey = generateApiKey(),
    callerId = await fresh(),
    authorId = await fresh();
  const instant = Date.now() - 2 * 60 * 60 * 1000;
  const values: {
    id: string;
    content: string;
    authorId: string;
    timestamp: string;
  }[] = [];
  for (let i = 0; i < 250; i++) {
    const id = await fresh(),
      delta = i < 30 ? (i + 1) * 60000 : i < 230 ? 0 : -(i - 229) * 60000;
    values.push({
      id,
      content: 'f27 owned page ' + id,
      authorId,
      timestamp: new Date(instant + delta).toISOString(),
    });
  }
  await control.begin(async (tx) => {
    await insertUser(tx, setupPending, callerId);
    await insertUser(tx, setupPending, authorId);
    await acquire(
      tx,
      setupPending,
      'Post',
      'INSERT INTO "Post"(id,content,"authorId","timestamp","createdAt") ' +
        'SELECT id,content,"authorId","timestamp"::timestamp,"timestamp"::timestamp ' +
        'FROM jsonb_to_recordset($1::text::jsonb) AS p(id text,content text,"authorId" text,"timestamp" text)',
      [JSON.stringify(values)],
      values.length
    );
    await acquire(
      tx,
      setupPending,
      'UserApiKey',
      'INSERT INTO "UserApiKey"(id,"userId","keyHash",name,"expiresAt") VALUES($1,$2,$3,$4,$5::timestamp)',
      [
        await fresh(),
        callerId,
        hashApiKey(rawKey),
        'Owned A2A feed fixture',
        new Date(Date.now() + 3600000).toISOString(),
      ]
    );
  });
  owned.push(...setupPending);
  setupPending.length = 0;
  caller = callerId;
  author = authorId;
  apiKey = rawKey;
  fixtureIds.push(...values.map((row) => row.id));
  firstKeyUse = new Date();
}, 30000);
afterAll(async () => {
  const failures: Error[] = [];
  for (const rows of [controls, owned]) {
    try {
      await cleanup(rows);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
    }
  }
  await control.end({ timeout: 5 });
  if (failures.length)
    throw new AggregateError(failures, 'Owned A2A feed cleanup refused');
}, 20000);

describe('A2A social.get_feed pagination', () => {
  it('pages through the entire feed with offset, each post exactly once', async () => {
    const expected = await orderedIds(),
      before = await physical(owned),
      seen: string[] = [];
    for (let offset = 0; offset <= expected.length; offset += 100) {
      const page = await feed({ limit: 100, offset });
      seen.push(...page.map((p) => p.id));
      if (page.length < 100) break;
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
    expect(seen.filter((id) => fixtureIds.includes(id))).toHaveLength(250);
    expect(await orderedIds()).toEqual(expected);
    expect(await physical(owned)).toEqual(before);
  }, 30000);
  it('returns distinct pages for distinct offsets', async () => {
    const expected = await orderedIds();
    expect((await feed({ limit: 10, offset: 0 })).map((p) => p.id)).toEqual(
      expected.slice(0, 10)
    );
    expect((await feed({ limit: 10, offset: 10 })).map((p) => p.id)).toEqual(
      expected.slice(10, 20)
    );
    expect((await feed({ limit: 10, offset: '10' })).map((p) => p.id)).toEqual(
      expected.slice(10, 20)
    );
    expect((await feed({ limit: 10, offset: -1 })).map((p) => p.id)).toEqual(
      expected.slice(0, 10)
    );
    for (const offset of [1e100, '9007199254740993']) {
      const response = await request({ limit: 10, offset });
      expect(response.status).toBe(200);
      const task = Envelope.parse(await response.json()).result;
      expect(task.status.state).toBe('failed');
      expect(
        task.status.message?.parts.map((part) => part.text || '').join(' ')
      ).toContain('offset must be a safe non-negative integer');
    }
    expect(await orderedIds()).toEqual(expected);
  });
  it('keeps the default first page at 20 newest posts', async () => {
    const expected = await orderedIds();
    expect((await feed({}, author)).map((p) => p.id)).toEqual(
      expected.slice(0, 20)
    );
    expect((await feed({ limit: 100000 })).map((p) => p.id)).toEqual(
      expected.slice(0, 100)
    );
    for (const key of ['', 'feed_invalid_pagination_key'])
      expect((await request({}, key)).status).toBe(401);
    expect(await orderedIds()).toEqual(expected);
  });
  it('owns only committed setup and refuses foreign Post and User children atomically', async () => {
    const before = await physical(owned),
      targetPost = fixtureIds[0];
    assert.ok(targetPost);
    for (const collision of ['User', 'Post'] as const) {
      const pending: Receipt[] = [],
        partial = await fresh();
      await expect(
        control.begin(async (tx) => {
          await insertUser(tx, pending, partial);
          if (collision === 'User')
            await insertUser(tx, pending, caller, 'collision_' + partial);
          else
            await acquire(
              tx,
              pending,
              'Post',
              'INSERT INTO "Post"(id,"authorId",content) VALUES($1,$2,$3)',
              [targetPost, partial, 'must roll back']
            );
        })
      ).rejects.toMatchObject({
        code: '23505',
        constraint_name: collision === 'User' ? 'User_pkey' : 'Post_pkey',
      });
      expect(
        await control.unsafe('SELECT id FROM "User" WHERE id=$1', [partial])
      ).toHaveLength(0);
      expect(await physical(owned)).toEqual(before);
    }
    const pending: Receipt[] = [];
    await control.begin(async (tx) => {
      const foreignUser = await fresh();
      await insertUser(tx, pending, foreignUser);
      await acquire(
        tx,
        pending,
        'Reaction',
        'INSERT INTO "Reaction"(id,"postId","userId",type) VALUES($1,$2,$3,$4)',
        [await fresh(), targetPost, foreignUser, 'like']
      );
      await acquire(
        tx,
        pending,
        'Post',
        'INSERT INTO "Post"(id,"authorId",content,"originalPostId") VALUES($1,$2,$3,$4)',
        [await fresh(), foreignUser, 'Separately owned child', targetPost]
      );
      await acquire(
        tx,
        pending,
        'GameOnboarding',
        'INSERT INTO "GameOnboarding"(id,"userId") VALUES($1,$2)',
        [await fresh(), caller]
      );
    });
    controls.push(...pending);
    for (const release of ['Reaction', 'Post', 'GameOnboarding'] as const) {
      const external = await physical(controls);
      await expect(cleanup(owned)).rejects.toThrow(
        'Owned A2A feed cleanup refused'
      );
      expect(await physical(owned)).toEqual(before);
      expect(await physical(controls)).toEqual(external);
      await releaseControls(release);
    }
  }, 30000);
});

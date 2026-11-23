/**
 * Existing test-author parity under PRD §§8.2/12, MVP Phase 5.
 * A2A retirement remains Phase 1 work; this retains existing MCP question/time rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { generateApiKey, hashApiKey } from '@feed/api';
import { StaticDataRegistry } from '@feed/engine';
import {
  generateSnowflakeId,
  isValidSnowflakeId,
  type JsonValue,
} from '@feed/shared';
import postgres from 'postgres';
import { z } from 'zod';

type Table =
  | 'User'
  | 'Post'
  | 'UserApiKey'
  | 'Reaction'
  | 'GameOnboarding'
  | 'Question';
type Physical = { id: string; canonical: string };
type Receipt = Physical & { table: Table };
const owned: Receipt[] = [],
  controls: Receipt[] = [];
const visibleIds: string[] = [],
  hiddenIds: string[] = [];
let absentAuthor = '',
  npcAuthor = '',
  absentPost = '',
  npcPost = '',
  deletedPost = '',
  futurePost = '',
  questionId = '',
  otherQuestionId = '';
let npcUserBefore: Physical[] = [];
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
  posts: z.array(
    z
      .object({
        id: z.string(),
        content: z.string(),
        authorId: z.string(),
        timestamp: z.string(),
      })
      .strict()
  ),
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
    'Question',
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
const questionGuard =
  ' AND NOT EXISTS(SELECT 1 FROM "ArcState" f WHERE f."questionId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "QuestionArcPlan" f WHERE f."questionId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "TimeframedMarket" f WHERE f."questionId"=t.id)' +
  ' AND NOT EXISTS(SELECT 1 FROM "Post" f WHERE f."relatedQuestion"=t."questionNumber")';
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await control.begin(async (tx) => {
    for (const table of ['User', 'Question', 'Post'] as const) {
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
      'Question',
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
        table === 'Post'
          ? postGuard
          : table === 'User'
            ? userGuard
            : table === 'Question'
              ? questionGuard
              : '';
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
        'Owned tool feed cleanup refused ' + table
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

const McpEnvelope = z.object({
  result: z.object({
    content: z.array(z.object({ type: z.string(), text: z.string() })),
    isError: z.boolean(),
  }),
});
async function mcpRequest(args: Record<string, JsonValue>, key = apiKey) {
  return fetch(base + '/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'X-Feed-Api-Key': key } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name: 'query_feed', arguments: args },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
}
async function mcpFeed(args: Record<string, JsonValue> = {}) {
  const response = await mcpRequest(args);
  expect(response.status).toBe(200);
  const result = McpEnvelope.parse(await response.json()).result;
  expect(result.isError).toBe(false);
  const text = result.content.find((part) => part.type === 'text')?.text;
  assert.ok(text);
  return FeedData.parse(JSON.parse(text)).posts;
}
// Read-only expected membership; these baseline rows are never acquired for cleanup.
async function eligible(mcp: boolean, question?: number) {
  return Array.from(
    await control.unsafe<{ id: string; timestamp: Date }[]>(
      'SELECT p.id,p.timestamp FROM "Post" p WHERE p."deletedAt" IS NULL AND p."authorId" NOT LIKE \'test-%\' ' +
        'AND NOT EXISTS(SELECT 1 FROM "User" u WHERE u.id=p."authorId" AND u."isTest"=true)' +
        (mcp ? ' AND p.timestamp<=now()' : '') +
        (question === undefined ? '' : ' AND p."relatedQuestion"=$1::integer') +
        ' ORDER BY p.timestamp DESC' +
        (mcp ? '' : ',p.id DESC'),
      question === undefined ? [] : [String(question)]
    )
  );
}
async function findA2A(ids: string[]) {
  const expected = await eligible(false),
    pages = new Set<number>(),
    found: string[] = [];
  for (const id of ids) {
    const index = expected.findIndex((row) => row.id === id);
    assert.ok(index >= 0);
    pages.add(Math.floor(index / 100) * 100);
  }
  for (const offset of pages) {
    const page = await feed({ limit: 100, offset });
    expect(page.map((row) => row.id)).toEqual(
      expected.slice(offset, offset + 100).map((row) => row.id)
    );
    found.push(...page.map((row) => row.id));
  }
  return found;
}
async function npcUser() {
  return Array.from(
    await control.unsafe<Physical[]>(
      'SELECT id,to_jsonb(t)::text AS canonical FROM "User" t WHERE id=$1',
      [npcAuthor]
    )
  );
}
let questionNumber = 0;
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
    authorId = await fresh(),
    flagged = await fresh(),
    banned = await fresh(),
    prefix = 'test-' + (await fresh());
  absentAuthor = await fresh();
  const actor = StaticDataRegistry.getActor('ailon-musk');
  assert.ok(actor);
  npcAuthor = actor.id;
  npcUserBefore = await npcUser();
  for (const row of npcUserBefore)
    expect(
      z.object({ isTest: z.boolean() }).parse(JSON.parse(row.canonical)).isTest
    ).toBe(false);
  const q1 = await fresh(),
    q2 = await fresh();
  questionNumber = 1000000000 + Number(BigInt(q1) % 900000000n);
  const now = Date.now(),
    values: {
      id: string;
      content: string;
      authorId: string;
      timestamp: string;
      relatedQuestion: number;
      deletedAt: string | null;
    }[] = [];
  const add = async (
    authorId: string,
    delta: number,
    deleted = false,
    question = questionNumber
  ) => {
    const id = await fresh();
    values.push({
      id,
      content: 'Owned feed parity ' + id,
      authorId,
      timestamp: new Date(now + delta).toISOString(),
      relatedQuestion: question,
      deletedAt: deleted ? new Date(now).toISOString() : null,
    });
    return id;
  };
  for (let i = 0; i < 3; i++)
    visibleIds.push(await add(authorId, -10000 - i * 100));
  visibleIds.push(await add(banned, -10400));
  absentPost = await add(absentAuthor, -10500);
  npcPost = await add(npcAuthor, -10600);
  visibleIds.push(absentPost, npcPost);
  await add(authorId, -10700, false, questionNumber + 1);
  deletedPost = await add(authorId, -10800, true);
  futurePost = await add(authorId, 86400000);
  // More than a whole page of newer excluded rows makes filtering-after-limit fail.
  for (let i = 0; i < 120; i++)
    hiddenIds.push(await add(i % 2 ? flagged : prefix, -1000 - i));
  const pending: Receipt[] = [];
  await control.begin(async (tx) => {
    await insertUser(tx, pending, callerId);
    await insertUser(tx, pending, authorId);
    await acquire(
      tx,
      pending,
      'User',
      'INSERT INTO "User"(id,username,"isTest","isBanned","updatedAt") SELECT id,username,"isTest","isBanned",now() FROM jsonb_to_recordset($1::text::jsonb) AS u(id text,username text,"isTest" boolean,"isBanned" boolean)',
      [
        JSON.stringify([
          {
            id: flagged,
            username: 'f27_' + flagged,
            isTest: true,
            isBanned: false,
          },
          {
            id: prefix,
            username: 'f27_' + prefix.slice(5),
            isTest: false,
            isBanned: false,
          },
          {
            id: banned,
            username: 'f27_' + banned,
            isTest: false,
            isBanned: true,
          },
        ]),
      ],
      3
    );
    for (const [id, number] of [
      [q1, questionNumber],
      [q2, questionNumber + 1],
    ] as const)
      await acquire(
        tx,
        pending,
        'Question',
        'INSERT INTO "Question"(id,"questionNumber",text,"scenarioId",outcome,rank,"resolutionDate","updatedAt") VALUES($1,$2::integer,$3,1,false,1,$4::timestamp,now())',
        [
          id,
          String(number),
          'Owned feed question ' + id,
          new Date(now + 86400000).toISOString(),
        ]
      );
    await acquire(
      tx,
      pending,
      'Post',
      'INSERT INTO "Post"(id,content,"authorId",timestamp,"createdAt","relatedQuestion","deletedAt") SELECT id,content,"authorId",timestamp::timestamp,timestamp::timestamp,"relatedQuestion","deletedAt"::timestamp FROM jsonb_to_recordset($1::text::jsonb) AS p(id text,content text,"authorId" text,timestamp text,"relatedQuestion" integer,"deletedAt" text)',
      [JSON.stringify(values)],
      values.length
    );
    await acquire(
      tx,
      pending,
      'UserApiKey',
      'INSERT INTO "UserApiKey"(id,"userId","keyHash",name,"expiresAt") VALUES($1,$2,$3,$4,$5::timestamp)',
      [
        await fresh(),
        callerId,
        hashApiKey(rawKey),
        'Owned feed parity fixture',
        new Date(now + 3600000).toISOString(),
      ]
    );
  });
  owned.push(...pending);
  caller = callerId;
  author = authorId;
  apiKey = rawKey;
  questionId = q1;
  otherQuestionId = q2;
  firstKeyUse = new Date();
  expect(
    await control.unsafe('SELECT id FROM "User" WHERE id=$1', [absentAuthor])
  ).toHaveLength(0);
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

describe('Agent feed test-author visibility', () => {
  it('A2A social.get_feed excludes test authors', async () => {
    const before = await physical(owned),
      ids = await findA2A(visibleIds);
    for (const id of visibleIds) expect(ids).toContain(id);
    for (const id of [...hiddenIds, deletedPost]) expect(ids).not.toContain(id);
    expect(await physical(owned)).toEqual(before);
  }, 30000);
  it('MCP query_feed excludes test authors', async () => {
    const expected = await eligible(true),
      before = await physical(owned),
      rows = await mcpFeed({ limit: Math.max(100, expected.length + 1) }),
      ids = rows.map((row) => row.id);
    expect([...ids].sort()).toEqual(expected.map((row) => row.id).sort());
    for (const id of visibleIds) expect(ids).toContain(id);
    for (const id of [...hiddenIds, deletedPost, futurePost])
      expect(ids).not.toContain(id);
    expect(await physical(owned)).toEqual(before);
  }, 30000);
  it('filters before the A2A limit and preserves offset and timestamp/id order', async () => {
    const expected = await eligible(false);
    for (const offset of [0, 10, 100])
      expect((await feed({ limit: 10, offset })).map((row) => row.id)).toEqual(
        expected.slice(offset, offset + 10).map((row) => row.id)
      );
    const top = (await feed({ limit: 100 })).map((row) => row.id);
    expect(top).toEqual(expected.slice(0, 100).map((row) => row.id));
    for (const id of hiddenIds) expect(top).not.toContain(id);
    const response = await request({ offset: '9007199254740993' });
    const task = Envelope.parse(await response.json()).result;
    expect(task.status.state).toBe('failed');
  });
  it('keeps an absent-User author and a real registry NPC without adopting its User', async () => {
    expect(
      await control.unsafe('SELECT id FROM "User" WHERE id=$1', [absentAuthor])
    ).toHaveLength(0);
    expect(StaticDataRegistry.getActor(npcAuthor)?.id).toBe(npcAuthor);
    expect(await findA2A([absentPost, npcPost])).toEqual(
      expect.arrayContaining([absentPost, npcPost])
    );
    expect(
      (await mcpFeed({ questionId, limit: 100 })).map((row) => row.id)
    ).toEqual(expect.arrayContaining([absentPost, npcPost]));
    expect(await npcUser()).toEqual(npcUserBefore);
  });
  it('preserves MCP question lookup, future/deleted exclusion and pre-limit filtering', async () => {
    const rows = await mcpFeed({ questionId, limit: 100 }),
      expected = await eligible(true, questionNumber);
    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(rows.map((row) => row.id)).toEqual(visibleIds);
    expect(
      (await mcpFeed({ questionId, limit: 3 })).map((row) => row.id)
    ).toEqual(visibleIds.slice(0, 3));
    expect(
      await mcpFeed({ questionId: otherQuestionId, limit: 100 })
    ).toHaveLength(1);
    const missing = await fresh(),
      response = await mcpRequest({ questionId: missing });
    expect(response.status).toBe(200);
    const result = McpEnvelope.parse(await response.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content.map((row) => row.text).join(' ')).toContain(
      'Question not found: ' + missing
    );
    expect(await findA2A([futurePost])).toContain(futurePost); // Existing A2A contract has no future-time filter.
  });
  it('uses the authenticated per-user key and rejects missing or invalid transport credentials', async () => {
    const before = await physical(owned);
    for (const key of ['', 'feed_invalid_test_author_key']) {
      expect((await request({}, key)).status).toBe(401);
      expect((await mcpRequest({}, key)).status).toBe(401);
    }
    const expected = await eligible(false);
    expect((await feed({ limit: 10 }, author)).map((row) => row.id)).toEqual(
      expected.slice(0, 10).map((row) => row.id)
    );
    expect(await physical(owned)).toEqual(before);
  });
  it('owns only committed setup and refuses foreign Post and User children atomically', async () => {
    const before = await physical(owned),
      targetPost = visibleIds[0];
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
        'Owned tool feed cleanup refused'
      );
      expect(await physical(owned)).toEqual(before);
      expect(await physical(controls)).toEqual(external);
      await releaseControls(release);
    }
  }, 30000);
});

/** PRD §12 / MVP Phase 5: existing Following API pagination, not new UI pagination. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  dbWrite,
  follows,
  gameOnboarding,
  posts,
  reactions,
  sql,
  users,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

type Table = 'User' | 'Follow' | 'Post' | 'Reaction' | 'GameOnboarding';
type Receipt = { table: Table; id: string; row: string };
const owned: Receipt[] = [];
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
const responseSchema = z.object({
  success: z.boolean(),
  posts: z.array(z.object({ id: z.string(), timestamp: z.string() })),
  source: z.string().optional(),
  nextCursor: z.string().nullable().optional(),
});
let viewerId = '',
  authorId = '',
  microViewerId = '',
  microAuthorId = '',
  token = '',
  microToken = '',
  tieTimestampIso = '',
  deletedTimestamp = '',
  futureTimestamp = '',
  ip = '';
const tieIds: string[] = [],
  olderIds: string[] = [],
  hiddenIds: string[] = [],
  microTieIds: string[] = [],
  microOlderIds: string[] = [];

function guard() {
  const value = process.env.DATABASE_URL || '';
  if (!URL.canParse(value) || !URL.canParse(base))
    throw new Error('Explicit disposable Following targets required');
  const database = new URL(value);
  const local =
    database.hostname === '127.0.0.1' &&
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
    database.protocol !== 'postgresql:' ||
    database.search ||
    database.hash ||
    !(local || ci) ||
    (process.env.DIRECT_DATABASE_URL &&
      process.env.DIRECT_DATABASE_URL !== value) ||
    process.env.DATABASE_READ_REPLICA_URL ||
    process.env.POSTGRES_URL
  )
    throw new Error(
      'Following fixture requires a disposable local or documented CI database'
    );
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
    throw new Error('Following HTTP target must be loopback');
  for (const target of [process.env.TEST_API_URL, process.env.TEST_BASE_URL])
    if (
      target &&
      (!URL.canParse(target) || new URL(target).origin !== endpoint.origin)
    )
      throw new Error('Following HTTP origins must agree');
}
function remember(
  table: Table,
  rows: Array<{ id: string; row: string }>,
  into = owned
) {
  for (const row of rows) into.push({ table, ...row });
  return rows;
}
async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  into = owned
) {
  const rows = remember(
    'User',
    await dbWrite
      .insert(users)
      .values(values)
      .returning({ id: users.id, row: sql<string>`to_jsonb("User")::text` }),
    into
  );
  expect(rows).toHaveLength(values.length);
  return rows;
}
async function insertPosts(
  values: Array<typeof posts.$inferInsert>,
  into = owned
) {
  const rows = remember(
    'Post',
    await dbWrite
      .insert(posts)
      .values(values)
      .returning({ id: posts.id, row: sql<string>`to_jsonb("Post")::text` }),
    into
  );
  expect(rows).toHaveLength(values.length);
  return rows;
}
async function read(row: Receipt) {
  return Array.from(
    await dbWrite.execute<{ row: string }>(
      sql`SELECT to_jsonb(t)::text AS row FROM ${sql.identifier(row.table)} t WHERE id=${row.id}`
    )
  );
}
function parentGuard(table: Table) {
  if (table === 'Post')
    return sql`
    NOT EXISTS(SELECT 1 FROM "Reaction" c WHERE c."postId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Comment" c WHERE c."postId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Share" c WHERE c."postId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "PostTag" c WHERE c."postId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Post" c WHERE c.id<>t.id AND (c."originalPostId"=t.id OR c."commentOnPostId"=t.id OR c."parentCommentId"=t.id))`;
  if (table === 'User')
    return sql`
    NOT EXISTS(SELECT 1 FROM "AdminRole" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "GameOnboarding" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Whitelist" c WHERE c."userId"=t.id OR c."grantedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "WhitelistConfig" c WHERE c."updatedBy"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Post" c WHERE c."authorId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Follow" c WHERE c."followerId"=t.id OR c."followingId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserActorFollow" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Reaction" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Comment" c WHERE c."authorId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "Share" c WHERE c."userId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserBlock" c WHERE c."blockerId"=t.id OR c."blockedId"=t.id) AND
    NOT EXISTS(SELECT 1 FROM "UserMute" c WHERE c."muterId"=t.id OR c."mutedId"=t.id)`;
  return sql`true`;
}
async function cleanup(rows: Receipt[]) {
  if (!rows.length) return;
  await withTransaction(async (tx) => {
    for (const table of ['User', 'Post'] as const) {
      for (const row of rows
        .filter((r) => r.table === table)
        .sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const locked = await tx.execute<{ row: string }>(
          sql`SELECT to_jsonb(t)::text AS row FROM ${sql.identifier(row.table)} t WHERE id=${row.id} FOR UPDATE`
        );
        if (locked.length !== 1 || locked[0]?.row !== row.row)
          throw new Error(`Retain changed Following ${row.table}`);
      }
    }
    for (const table of [
      'Reaction',
      'GameOnboarding',
      'Post',
      'Follow',
      'User',
    ] as const) {
      for (const row of rows.filter((r) => r.table === table)) {
        const deleted = await tx.execute<{ id: string }>(
          sql`DELETE FROM ${sql.identifier(table)} t WHERE t.id=${row.id} AND to_jsonb(t)=${row.row}::text::jsonb AND ${parentGuard(table)} RETURNING t.id`
        );
        if (deleted.length !== 1 || deleted[0]?.id !== row.id)
          throw new Error(`Retain changed or referenced Following ${table}`);
      }
    }
  });
  for (const row of rows) expect(await read(row)).toEqual([]);
  rows.length = 0;
}
async function page(
  limit: number,
  cursor?: string,
  micro = false,
  override: { userId?: string; auth?: string } = {}
) {
  const params = new URLSearchParams({
    following: 'true',
    userId: override.userId ?? (micro ? microViewerId : viewerId),
    limit: String(limit),
  });
  if (cursor !== undefined) params.set('cursor', cursor);
  const auth = override.auth ?? (micro ? microToken : token);
  const response = await fetch(`${base}/api/posts?${params}`, {
    headers: {
      'x-forwarded-for': ip,
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  expect(response.status).toBe(200);
  return { response, body: responseSchema.parse(await response.json()) };
}
async function walk(limit: number, micro = false) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 12; index++) {
    const { body } = await page(limit, cursor, micro);
    expect(body.source).toBe('following');
    seen.push(...body.posts.map((p) => p.id));
    const last = body.posts.at(-1);
    if (!last || body.nextCursor === null) return seen;
    const next = body.nextCursor ?? last.timestamp;
    if (next === cursor) throw new Error('Following cursor did not advance');
    cursor = next;
  }
  throw new Error('Following traversal exceeded its fixture bound');
}
async function primaryCollision(
  operation: () => Promise<Array<{ id: string; row: string }>>,
  constraint: 'User_pkey' | 'Post_pkey'
) {
  try {
    await operation();
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === constraint
    )
      return;
    throw error;
  }
  throw new Error('Expected the real Following fixture primary-key collision');
}

beforeAll(async () => {
  guard();
  const target = new URL(process.env.DATABASE_URL || '');
  const [actual] = await dbWrite.execute<{
    database: string;
    role: string;
    session: string;
    server: string;
    port: number;
    replica: boolean;
  }>(
    sql`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_catalog.host(inet_server_addr()) AS server,inet_server_port() AS port,pg_is_in_recovery() AS replica`
  );
  const exactJobService =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    target.hostname === 'localhost' &&
    target.port === '5432' &&
    target.pathname === '/test_db' &&
    target.username === 'postgres' &&
    !!process.env.FEED_TEST_POSTGRES_ADDRESS &&
    actual?.server === process.env.FEED_TEST_POSTGRES_ADDRESS;
  if (
    !actual ||
    actual.database !== decodeURIComponent(target.pathname.slice(1)) ||
    actual.role !== decodeURIComponent(target.username) ||
    actual.session !== actual.role ||
    actual.port !== Number(target.port) ||
    actual.replica ||
    (!['127.0.0.1', '::1'].includes(actual.server) && !exactJobService)
  )
    throw new Error('Following actual disposable backend identity differs');
  const now = Date.now();
  [viewerId, authorId, microViewerId, microAuthorId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const testAuthorId = await generateSnowflakeId(),
    strangerId = await generateSnowflakeId();
  const groups = BigInt(viewerId).toString(16).padStart(16, '0').match(/.{4}/g);
  if (!groups) throw new Error('Following fixture IP allocation failed');
  ip = `2001:db8:1711:0:${groups.join(':')}`;
  await insertUsers(
    [
      viewerId,
      authorId,
      microViewerId,
      microAuthorId,
      testAuthorId,
      strangerId,
    ].map((id, index) => ({
      id,
      username: `g35-${id}`,
      displayName: 'Owned Following fixture',
      stewardId: index === 0 || index === 2 ? `following-${id}` : null,
      isTest: id === testAuthorId,
      updatedAt: new Date(now),
    }))
  );
  const followValues: Array<typeof follows.$inferInsert> = [];
  for (const [followerId, followingId] of [
    [viewerId, authorId],
    [viewerId, testAuthorId],
    [microViewerId, microAuthorId],
  ] as const)
    followValues.push({
      id: await generateSnowflakeId(),
      followerId,
      followingId,
    });
  const followed = remember(
    'Follow',
    await dbWrite
      .insert(follows)
      .values(followValues)
      .returning({ id: follows.id, row: sql<string>`to_jsonb("Follow")::text` })
  );
  expect(followed).toHaveLength(3);
  token = await createStewardTestToken(`following-${viewerId}`);
  microToken = await createStewardTestToken(`following-${microViewerId}`);
  const tieAt = new Date(now - 600000);
  tieTimestampIso = tieAt.toISOString();
  deletedTimestamp = new Date(now - 300000).toISOString();
  futureTimestamp = new Date(now + 3600000).toISOString();
  const values: Array<typeof posts.$inferInsert> = [];
  for (let index = 0; index < 5; index++) {
    const id = await generateSnowflakeId();
    tieIds.push(id);
    values.push({
      id,
      authorId,
      content: 'Following shared timestamp',
      timestamp: tieAt,
      createdAt: tieAt,
    });
  }
  for (const minutes of [70, 130]) {
    const id = await generateSnowflakeId();
    olderIds.push(id);
    values.push({
      id,
      authorId,
      content: 'Following older post',
      timestamp: new Date(now - minutes * 60000),
      createdAt: new Date(now - minutes * 60000),
    });
  }
  for (const [idAuthor, stamp, deletedAt] of [
    [authorId, deletedTimestamp, new Date(now - 240000)],
    [authorId, futureTimestamp, null],
    [testAuthorId, deletedTimestamp, null],
    [strangerId, deletedTimestamp, null],
  ] as const) {
    const id = await generateSnowflakeId();
    hiddenIds.push(id);
    values.push({
      id,
      authorId: idAuthor,
      content: 'Following hidden control',
      timestamp: new Date(stamp),
      createdAt: new Date(stamp),
      deletedAt,
    });
  }
  await insertPosts(values);
  const microTimestamp = new Date(now - 1200000)
    .toISOString()
    .replace('Z', '456Z');
  const microOlderTimestamp = microTimestamp.replace('456Z', '455Z');
  for (let index = 0; index < 7; index++) {
    const id = await generateSnowflakeId();
    (index < 5 ? microTieIds : microOlderIds).push(id);
    const stamp = index < 5 ? microTimestamp : microOlderTimestamp;
    const rows = remember(
      'Post',
      await dbWrite.execute<{ id: string; row: string }>(
        sql`INSERT INTO "Post" (id,"authorId",content,timestamp,"createdAt") VALUES (${id},${microAuthorId},'Following actual PostgreSQL microseconds',${stamp}::text::timestamp,${stamp}::text::timestamp) RETURNING id,to_jsonb("Post")::text AS row`
      )
    );
    expect(rows).toHaveLength(1);
  }
}, 30000);
afterAll(async () => {
  try {
    await cleanup(owned);
  } finally {
    token = '';
    microToken = '';
  }
}, 30000);

describe('GET /api/posts?following=true pagination across equal timestamps', () => {
  it('reaches every visible post exactly once when a page boundary falls inside a tie group', async () => {
    const seen = await walk(2);
    const expected = [...[...tieIds].reverse(), ...olderIds];
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  }, 30000);
  it('keeps legacy timestamp-only cursors working for distinct timestamps', async () => {
    const { body } = await page(10, tieTimestampIso);
    expect(body.posts.map((p) => p.id)).toEqual(olderIds);
  });
  it('never returns the soft-deleted or future-dated control posts', async () => {
    const { body } = await page(50);
    const ids = body.posts.map((p) => p.id);
    expect(ids).toHaveLength(7);
    for (const id of hiddenIds) expect(ids).not.toContain(id);
  });
  it('resumes actual stored microseconds inside ties and reaches the next microsecond bucket', async () => {
    const seen = await walk(2, true);
    expect(seen).toEqual([
      ...[...microTieIds].reverse(),
      ...[...microOlderIds].reverse(),
    ]);
    expect(new Set(seen).size).toBe(7);
  });
  it('retains the existing missing, deleted and future anchor fallback', async () => {
    const missing = await generateSnowflakeId();
    const { body } = await page(50, `${tieTimestampIso}_${missing}`);
    expect(body.posts.map((p) => p.id)).toEqual(olderIds);
    for (const [index, stamp] of [
      [0, deletedTimestamp],
      [1, futureTimestamp],
    ] as const) {
      const id = hiddenIds[index];
      if (!id) throw new Error('Missing acquired fallback control');
      const { body } = await page(50, `${stamp}_${id}`);
      expect(body.posts.map((p) => p.id)).toEqual([
        ...[...tieIds].reverse(),
        ...olderIds,
      ]);
    }
  });
  it('keeps Following personalization bound to the real authenticated viewer', async () => {
    for (const override of [{ auth: '' }, { userId: microViewerId }]) {
      const { body } = await page(2, undefined, false, override);
      expect(body.source).not.toBe('following');
    }
    const { response } = await page(2);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('acquires only successful rows and preserves real User and Post collision owners', async () => {
    const partial: Receipt[] = [],
      rejected: Receipt[] = [];
    const user = owned.find((r) => r.table === 'User' && r.id === authorId),
      post = owned.find((r) => r.table === 'Post' && r.id === tieIds[0]);
    if (!user || !post) throw new Error('Missing acquired collision owners');
    const collisionPostId = post.id;
    try {
      await insertUsers(
        [{ id: await generateSnowflakeId(), updatedAt: new Date() }],
        partial
      );
      const laterUser = await generateSnowflakeId();
      await primaryCollision(
        () =>
          insertUsers(
            [
              { id: laterUser, updatedAt: new Date() },
              { id: authorId, updatedAt: new Date() },
            ],
            rejected
          ),
        'User_pkey'
      );
      expect(rejected).toEqual([]);
      expect(await read({ table: 'User', id: laterUser, row: '' })).toEqual([]);
      const laterPost = await generateSnowflakeId();
      await primaryCollision(
        () =>
          insertPosts(
            [
              { id: laterPost, authorId, content: 'Failed partial post' },
              { id: collisionPostId, authorId, content: 'Collision' },
            ],
            rejected
          ),
        'Post_pkey'
      );
      expect(rejected).toEqual([]);
      expect(await read({ table: 'Post', id: laterPost, row: '' })).toEqual([]);
      expect(await read(user)).toEqual([{ row: user.row }]);
      expect(await read(post)).toEqual([{ row: post.row }]);
    } finally {
      await cleanup(partial);
    }
  });
  it('retains foreign Post and User children before guarded child-first cleanup', async () => {
    const parents: Receipt[] = [],
      children: Receipt[] = [];
    try {
      const [user] = await insertUsers(
        [{ id: await generateSnowflakeId(), updatedAt: new Date() }],
        parents
      );
      if (!user) throw new Error('Missing acquired foreign-reference user');
      const [post] = await insertPosts(
        [
          {
            id: await generateSnowflakeId(),
            authorId: user.id,
            content: 'Owned foreign-reference control',
          },
        ],
        parents
      );
      if (!post) throw new Error('Missing acquired foreign-reference post');
      remember(
        'Reaction',
        await dbWrite
          .insert(reactions)
          .values({
            id: await generateSnowflakeId(),
            postId: post.id,
            userId: user.id,
          })
          .returning({
            id: reactions.id,
            row: sql<string>`to_jsonb("Reaction")::text`,
          }),
        children
      );
      remember(
        'GameOnboarding',
        await dbWrite
          .insert(gameOnboarding)
          .values({ id: await generateSnowflakeId(), userId: user.id })
          .returning({
            id: gameOnboarding.id,
            row: sql<string>`to_jsonb("GameOnboarding")::text`,
          }),
        children
      );
      expect(children).toHaveLength(2);
      await expect(cleanup(parents)).rejects.toThrow(
        'Retain changed or referenced Following Post'
      );
      await expect(
        cleanup(parents.filter((r) => r.table === 'User'))
      ).rejects.toThrow('Retain changed or referenced Following User');
      for (const row of [...parents, ...children])
        expect(await read(row)).toEqual([{ row: row.row }]);
    } finally {
      await cleanup(children);
      await cleanup(parents);
    }
  });
});

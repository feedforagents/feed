/** PRD §§6.1/12, MVP5: retained profile repost counts through actual HTTP. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  comments,
  db,
  eq,
  inArray,
  posts,
  reactions,
  shares,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

// Guard every effective connection before this fixture performs any DB operation.
if (process.env.DATABASE_READ_REPLICA_URL?.trim())
  throw new Error('Profile fixture refuses a read replica');
function databaseTarget(value: string | undefined) {
  if (!value) throw new Error('Explicit fixture database URL required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !(
      (port === '55685' &&
        /^feed_pr\d+$/.test(name) &&
        url.username === 'symbiex') ||
      (port === '5432' && name === 'test_db' && process.env.CI === 'true')
    )
  )
    throw new Error('Disposable loopback fixture database required');
  return `${port}/${name}/${url.username}`;
}
const primary = databaseTarget(process.env.DATABASE_URL);
if (
  process.env.DIRECT_DATABASE_URL &&
  databaseTarget(process.env.DIRECT_DATABASE_URL) !== primary
)
  throw new Error('Fixture primary and direct database targets differ');

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const endpoint = new URL(base);
if (
  endpoint.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Disposable loopback HTTP server required');

const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  reactions: new Set<string>(),
  shares: new Set<string>(),
};
const userIds = new Map<string, string>(),
  postIds = new Map<string, string>(),
  commentIds = new Map<string, string>(),
  usernames = new Map<string, string>(),
  tokens = new Map<string, string>();
let runId = '',
  clientIp = '';
let expectedOrder: string[] = [];
const itemSchema = z
  .object({
    id: z.string(),
    commentCount: z.number().int().nonnegative(),
    isLiked: z.boolean(),
    isShared: z.boolean(),
    originalPostId: z.string().nullable().optional(),
    originalPost: z
      .object({ id: z.string() })
      .passthrough()
      .nullable()
      .optional(),
    isQuote: z.union([z.boolean(), z.literal('')]).optional(),
  })
  .passthrough();
const responseSchema = z.object({
  type: z.literal('posts'),
  total: z.number().int().nonnegative(),
  items: z.array(itemSchema),
});
function get(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error(`Missing owned fixture ${label}`);
  return value;
}
const user = (label: string) => get(userIds, label),
  post = (label: string) => get(postIds, label),
  comment = (label: string) => get(commentIds, label);
function headers(viewer?: string, cookie = false): Record<string, string> {
  const result: Record<string, string> = { 'x-forwarded-for': clientIp };
  if (viewer) {
    const token = get(tokens, viewer);
    result[cookie ? 'cookie' : 'authorization'] = cookie
      ? `steward-token=${token}`
      : `Bearer ${token}`;
  }
  return result;
}
async function request(
  query = '',
  viewer?: string,
  cookie = false,
  identifier = user('profile'),
  extra: Record<string, string> = {}
) {
  return fetch(
    `${base}/api/users/${encodeURIComponent(identifier)}/posts?type=posts${query}`,
    {
      headers: { ...headers(viewer, cookie), ...extra },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }
  );
}
async function page(
  query = '',
  viewer?: string,
  cookie = false,
  identifier = user('profile'),
  extra: Record<string, string> = {}
) {
  const response = await request(query, viewer, cookie, identifier, extra);
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  expect(body.total).toBe(body.items.length); // The posts contract is this page's length.
  return { body, response };
}
function find(body: z.infer<typeof responseSchema>, label: string) {
  const row = body.items.find((item) => item.id === post(label));
  if (!row) throw new Error(`Expected visible owned post ${label}`);
  return row;
}

beforeAll(async () => {
  runId = await generateSnowflakeId();
  const hex = BigInt(runId).toString(16).padStart(16, '0');
  const groups = hex.match(/.{4}/g);
  if (!groups || groups.length !== 4)
    throw new Error('Fixture IPv6 allocation failed');
  clientIp = `2001:db8:1694:0:${groups.join(':')}`;
  const now = new Date(),
    past = now.getTime() - 3_600_000;
  const userRows: Array<typeof users.$inferInsert> = [];
  for (const label of ['profile', 'original', 'viewer', 'other']) {
    const id = await generateSnowflakeId(),
      username = `p1694_${label}_${runId.slice(-10)}`;
    userIds.set(label, id);
    usernames.set(label, username);
    userRows.push({
      id,
      username,
      displayName: `Owned profile fixture ${label}`,
      stewardId: `p1694-${id}`,
      updatedAt: now,
    });
  }
  for (const row of await db
    .insert(users)
    .values(userRows)
    .returning({ id: users.id }))
    owned.users.add(row.id);
  for (const label of ['viewer', 'other'])
    tokens.set(label, await createStewardTestToken(`p1694-${user(label)}`));
  const rows: Array<typeof posts.$inferInsert> = [],
    visible: Array<{ id: string; timestamp: number }> = [];
  async function add(
    label: string,
    author: string,
    content: string,
    timestamp: number,
    extra: Partial<typeof posts.$inferInsert> = {},
    shown = false
  ) {
    const id = await generateSnowflakeId();
    postIds.set(label, id);
    rows.push({
      id,
      authorId: user(author),
      content: `${content ? runId + ' ' : ''}${content}`,
      timestamp: new Date(timestamp),
      createdAt: new Date(timestamp),
      ...extra,
    });
    if (shown) visible.push({ id, timestamp });
    return id;
  }
  await add('original', 'original', 'live original', past);
  await add('deleted-only-original', 'original', 'all comments deleted', past);
  await add('empty-original', 'original', 'no comments', past);
  await add('deleted-original', 'original', 'deleted original', past, {
    deletedAt: now,
  });
  await add(
    'repost',
    'profile',
    '',
    past + 1000,
    { originalPostId: post('original') },
    true
  );
  await add('own', 'profile', 'own post', past + 2000, {}, true);
  await add(
    'quote',
    'profile',
    'quote commentary',
    past + 2000,
    { originalPostId: post('original') },
    true
  );
  await add(
    'deleted-only-repost',
    'profile',
    '',
    past + 3000,
    { originalPostId: post('deleted-only-original') },
    true
  );
  await add(
    'empty-repost',
    'profile',
    '',
    past + 4000,
    { originalPostId: post('empty-original') },
    true
  );
  await add(
    'tombstone-quote',
    'profile',
    'commentary remains',
    past + 5000,
    { originalPostId: post('deleted-original') },
    true
  );
  await add('hidden-repost', 'profile', '', now.getTime() - 1000, {
    originalPostId: post('deleted-original'),
  });
  await add('deleted-own', 'profile', 'deleted own', now.getTime() - 1000, {
    deletedAt: now,
  });
  await add('future-own', 'profile', 'future own', now.getTime() + 86_400_000);
  for (const row of await db
    .insert(posts)
    .values(rows)
    .returning({ id: posts.id }))
    owned.posts.add(row.id);
  expectedOrder = visible
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))
    .map((row) => row.id);
  const commentRows: Array<typeof comments.$inferInsert> = [];
  for (const [label, target, live, deleted] of [
    ['original', 'original', 3, 2],
    ['own', 'own', 2, 1],
    ['quote', 'quote', 4, 1],
    ['deleted-only', 'deleted-only-original', 0, 2],
    ['tombstone', 'tombstone-quote', 1, 1],
  ] as const) {
    for (let i = 0; i < live + deleted; i++) {
      const id = await generateSnowflakeId();
      commentIds.set(`${label}-${i}`, id);
      commentRows.push({
        id,
        postId: post(target),
        authorId: user('original'),
        content: `${runId} ${label} ${i}`,
        createdAt: new Date(past + i),
        updatedAt: now,
        deletedAt: i >= live ? now : null,
      });
    }
  }
  for (const row of await db
    .insert(comments)
    .values(commentRows)
    .returning({ id: comments.id }))
    owned.comments.add(row.id);
  for (const row of await db
    .insert(reactions)
    .values([
      {
        id: await generateSnowflakeId(),
        userId: user('viewer'),
        postId: post('repost'),
        type: 'like',
      },
      {
        id: await generateSnowflakeId(),
        userId: user('other'),
        postId: post('own'),
        type: 'like',
      },
    ])
    .returning({ id: reactions.id }))
    owned.reactions.add(row.id);
  for (const row of await db
    .insert(shares)
    .values({
      id: await generateSnowflakeId(),
      userId: user('viewer'),
      postId: post('own'),
    })
    .returning({ id: shares.id }))
    owned.shares.add(row.id);
});

afterAll(async () => {
  const cleanup: Record<
    string,
    { owned: number; removed: number; remaining: number }
  > = {};
  try {
    for (const [kind, table] of [
      ['reactions', reactions],
      ['shares', shares],
      ['comments', comments],
      ['posts', posts],
      ['users', users],
    ] as const) {
      const ids = [...owned[kind]];
      const removed = ids.length
        ? await db
            .delete(table)
            .where(inArray(table.id, ids))
            .returning({ id: table.id })
        : [];
      const remaining = ids.length
        ? (
            await db
              .select({ id: table.id })
              .from(table)
              .where(inArray(table.id, ids))
          ).length
        : 0;
      cleanup[kind] = { owned: ids.length, removed: removed.length, remaining };
      expect(remaining).toBe(0);
    }
  } finally {
    console.log(
      'PR1694_HTTP_CLEANUP',
      JSON.stringify({
        runId,
        cleanup,
        returnedOwnershipOnly: true,
        noGlobalFlushOrDisconnect: true,
      })
    );
  }
});

describe('actual HTTP profile repost comment counts', () => {
  it('counts three live comments for a simple repost and keeps own-post count two', async () => {
    const { body } = await page();
    expect(find(body, 'repost').commentCount).toBe(3);
    expect(find(body, 'own').commentCount).toBe(2);
    expect(find(body, 'repost').originalPost?.id).toBe(post('original'));
  });
  it('uses quote-owned comments rather than original counts and retains tombstones', async () => {
    const { body } = await page();
    expect(find(body, 'quote').commentCount).toBe(4);
    expect(find(body, 'quote').isQuote).toBe(true);
    expect(find(body, 'tombstone-quote').commentCount).toBe(1);
    expect(find(body, 'tombstone-quote').originalPost).toBeNull();
    expect(find(body, 'tombstone-quote').isQuote).toBe(true);
  });
  it('returns zero for all-deleted and empty original comment groups', async () => {
    const { body } = await page();
    expect(find(body, 'deleted-only-repost').commentCount).toBe(0);
    expect(find(body, 'empty-repost').commentCount).toBe(0);
  });
  it('preserves visible membership, pre-limit exclusions and page-length totals', async () => {
    const { body } = await page();
    expect(body.items.map((row) => row.id)).toEqual(expectedOrder);
    for (const label of ['deleted-own', 'future-own', 'hidden-repost'])
      expect(body.items.map((row) => row.id)).not.toContain(post(label));
    const walked: string[] = [];
    for (let number = 1; number <= 4; number++) {
      const { body: slice } = await page(`&page=${number}&limit=2`);
      expect(slice.items.map((row) => row.id)).toEqual(
        expectedOrder.slice((number - 1) * 2, number * 2)
      );
      walked.push(...slice.items.map((row) => row.id));
    }
    expect(walked).toEqual(expectedOrder);
    expect(new Set(walked).size).toBe(6);
  });
  it('reflects an owned comment soft-delete and restore through fresh origin reads', async () => {
    const id = comment('original-0');
    expect(owned.comments.has(id)).toBe(true);
    try {
      const changed = await db
        .update(comments)
        .set({ deletedAt: new Date() })
        .where(eq(comments.id, id))
        .returning({ id: comments.id });
      expect(changed.map((row) => row.id)).toEqual([id]);
      expect(find((await page()).body, 'repost').commentCount).toBe(2);
      expect(find((await page()).body, 'quote').commentCount).toBe(4);
    } finally {
      await db
        .update(comments)
        .set({ deletedAt: null })
        .where(eq(comments.id, id));
    }
    expect(find((await page()).body, 'repost').commentCount).toBe(3);
  });
  it('binds signed Bearer/cookie viewer enrichment without changing public counts', async () => {
    for (const [viewer, cookie, repostLiked, ownLiked, ownShared] of [
      [undefined, false, false, false, false],
      ['viewer', false, true, false, true],
      ['viewer', true, true, false, true],
      ['other', false, false, true, false],
    ] as const) {
      const { body, response } = await page(
        `&userId=${user('other')}`,
        viewer,
        cookie
      );
      expect(find(body, 'repost').commentCount).toBe(3);
      expect(find(body, 'own').commentCount).toBe(2);
      expect(find(body, 'repost').isLiked).toBe(repostLiked);
      expect(find(body, 'own').isLiked).toBe(ownLiked);
      expect(find(body, 'own').isShared).toBe(ownShared);
      expect(response.headers.get('x-ratelimit-limit')).not.toBeNull();
      expect(response.headers.get('cache-control')).not.toBeNull();
    }
  });
  it('retains username and optional-invalid-auth public browsing and input contracts', async () => {
    const username = get(usernames, 'profile');
    expect(
      (await page('', undefined, false, username)).body.items.map(
        (row) => row.id
      )
    ).toEqual(expectedOrder);
    const invalid = await page('', undefined, false, user('profile'), {
      authorization: 'Bearer invalid-p1694',
    });
    expect(find(invalid.body, 'repost').commentCount).toBe(3);
    expect(find(invalid.body, 'repost').isLiked).toBe(false);
    const missing = await page(
      '',
      undefined,
      false,
      await generateSnowflakeId()
    );
    expect(missing.body.items).toEqual([]);
    expect(missing.body.total).toBe(0);
    for (const query of ['&page=0', '&page=1.5', '&limit=0', '&limit=101']) {
      const response = await request(query);
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
  });
  it('acquires no teardown ownership for atomic collisions and cleans partial setup', async () => {
    const partialId = await generateSnowflakeId(),
      attemptedUser = await generateSnowflakeId(),
      attemptedPost = await generateSnowflakeId(),
      attemptedComment = await generateSnowflakeId();
    const partial = new Set<string>(),
      failedUsers: string[] = [],
      failedPosts: string[] = [],
      failedComments: string[] = [];
    try {
      for (const row of await db
        .insert(users)
        .values({
          id: partialId,
          username: `p1694_partial_${partialId}`,
          updatedAt: new Date(),
        })
        .returning({ id: users.id })) {
        partial.add(row.id);
        owned.users.add(row.id);
      }
      await expect(
        (async () => {
          const rows = await db
            .insert(users)
            .values([
              {
                id: attemptedUser,
                username: `p1694_fail_${attemptedUser}`,
                updatedAt: new Date(),
              },
              {
                id: user('profile'),
                username: `p1694_collision_${attemptedUser}`,
                updatedAt: new Date(),
              },
            ])
            .returning({ id: users.id });
          failedUsers.push(...rows.map((row) => row.id));
        })()
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        (async () => {
          const rows = await db
            .insert(posts)
            .values([
              {
                id: attemptedPost,
                authorId: partialId,
                content: `${runId} partial`,
                timestamp: new Date(),
              },
              {
                id: post('original'),
                authorId: partialId,
                content: `${runId} collision`,
                timestamp: new Date(),
              },
            ])
            .returning({ id: posts.id });
          failedPosts.push(...rows.map((row) => row.id));
        })()
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        (async () => {
          const rows = await db
            .insert(comments)
            .values([
              {
                id: attemptedComment,
                postId: post('original'),
                authorId: partialId,
                content: `${runId} partial`,
                updatedAt: new Date(),
              },
              {
                id: comment('original-0'),
                postId: post('original'),
                authorId: partialId,
                content: `${runId} collision`,
                updatedAt: new Date(),
              },
            ])
            .returning({ id: comments.id });
          failedComments.push(...rows.map((row) => row.id));
        })()
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(failedUsers).toEqual([]);
      expect(failedPosts).toEqual([]);
      expect(failedComments).toEqual([]);
      expect(
        (
          await db
            .select({ id: users.id })
            .from(users)
            .where(inArray(users.id, [user('profile'), attemptedUser]))
        ).map((row) => row.id)
      ).toEqual([user('profile')]);
      expect(
        (
          await db
            .select({ id: posts.id })
            .from(posts)
            .where(inArray(posts.id, [post('original'), attemptedPost]))
        ).map((row) => row.id)
      ).toEqual([post('original')]);
      expect(
        (
          await db
            .select({ id: comments.id })
            .from(comments)
            .where(
              inArray(comments.id, [comment('original-0'), attemptedComment])
            )
        ).map((row) => row.id)
      ).toEqual([comment('original-0')]);
    } finally {
      if (partial.size)
        await db.delete(users).where(inArray(users.id, [...partial]));
    }
    expect(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, partialId))
      ).length
    ).toBe(0);
    expect(find((await page()).body, 'repost').commentCount).toBe(3);
  });
});

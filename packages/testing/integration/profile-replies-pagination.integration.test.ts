/** PRD §§6.1/12, MVP phase5: restore validated public profile reply pages. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { comments, db, eq, inArray, posts, reactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const target = new URL(base);
if (
  target.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
)
  throw new Error('Owned loopback HTTP server required');
const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  reactions: new Set<string>(),
};
const identities = new Map<string, string>(),
  postIds = new Map<string, string>(),
  replyIds = new Map<string, string>(),
  tokens = new Map<string, string>();
let runId = '',
  clientIp = '';
let ordered: string[] = [],
  overflowOrder: string[] = [];
const replySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    isLiked: z.boolean(),
    likeCount: z.number(),
    post: z
      .object({ id: z.string(), content: z.string() })
      .passthrough()
      .nullable(),
    parentComment: z
      .object({ id: z.string(), content: z.string() })
      .passthrough()
      .nullable(),
  })
  .passthrough();
const bodySchema = z.object({
  type: z.literal('replies'),
  total: z.number().int().nonnegative(),
  items: z.array(replySchema),
});
function lookup(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error('Missing owned fixture ' + label);
  return value;
}
const user = (label: string) => lookup(identities, label),
  post = (label: string) => lookup(postIds, label),
  reply = (label: string) => lookup(replyIds, label);
function auth(label?: string, cookie = false): Record<string, string> {
  if (!label) return {};
  const token = lookup(tokens, label);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}
async function request(
  query = '',
  viewer?: string,
  cookie = false,
  profile = 'author'
) {
  return fetch(
    `${base}/api/users/${user(profile)}/posts?type=replies${query}`,
    {
      headers: { 'x-forwarded-for': clientIp, ...auth(viewer, cookie) },
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
  profile = 'author'
) {
  const response = await request(query, viewer, cookie, profile);
  expect(response.status).toBe(200);
  return bodySchema.parse(await response.json());
}

beforeAll(async () => {
  runId = await generateSnowflakeId();
  clientIp = `2001:db8:1688:0:${BigInt(runId).toString(16).padStart(16, '0').match(/.{4}/g)!.join(':')}`;
  const now = new Date(),
    past = new Date(now.getTime() - 3600000);
  const userRows: Array<typeof users.$inferInsert> = [];
  for (const label of ['author', 'parent', 'viewer', 'other', 'overflow']) {
    const id = await generateSnowflakeId();
    identities.set(label, id);
    userRows.push({
      id,
      username: `p1688_${label}_${runId.slice(-10)}`,
      displayName: 'Owned reply fixture ' + label,
      stewardId: `p1688-${id}`,
      updatedAt: now,
    });
  }
  for (const row of await db
    .insert(users)
    .values(userRows)
    .returning({ id: users.id }))
    owned.users.add(row.id);
  for (const label of ['viewer', 'other'])
    tokens.set(label, await createStewardTestToken(`p1688-${user(label)}`));
  const postRows: Array<typeof posts.$inferInsert> = [];
  for (const label of ['live', 'deleted', 'future']) {
    const id = await generateSnowflakeId();
    postIds.set(label, id);
    postRows.push({
      id,
      authorId: user('parent'),
      content: `${runId} ${label} parent`,
      timestamp: label === 'future' ? new Date(now.getTime() + 3600000) : past,
      createdAt: past,
      deletedAt: label === 'deleted' ? now : null,
    });
  }
  for (const row of await db
    .insert(posts)
    .values(postRows)
    .returning({ id: posts.id }))
    owned.posts.add(row.id);
  const parentRows: Array<typeof comments.$inferInsert> = [];
  for (const label of ['parent-live', 'parent-deleted']) {
    const id = await generateSnowflakeId();
    replyIds.set(label, id);
    parentRows.push({
      id,
      authorId: user('parent'),
      postId: post('live'),
      content: `${runId} ${label}`,
      createdAt: past,
      updatedAt: past,
      deletedAt: label === 'parent-deleted' ? now : null,
    });
  }
  for (const row of await db
    .insert(comments)
    .values(parentRows)
    .returning({ id: comments.id }))
    owned.comments.add(row.id);
  const definitions = [
    { label: 'newest', age: 1, post: 'live' },
    { label: 'tie-a', age: 2, post: 'live' },
    { label: 'tie-b', age: 2, post: 'live' },
    { label: 'deleted-parent', age: 3, post: 'deleted' },
    { label: 'future-parent', age: 4, post: 'future' },
    {
      label: 'deleted-comment-parent',
      age: 5,
      post: 'live',
      parent: 'parent-deleted',
    },
    {
      label: 'live-comment-parent',
      age: 6,
      post: 'live',
      parent: 'parent-live',
    },
  ];
  const replyRows: Array<typeof comments.$inferInsert> = [],
    expected: Array<{ id: string; time: number }> = [];
  for (const def of definitions) {
    const id = await generateSnowflakeId(),
      time = now.getTime() - 60000 - def.age * 1000;
    replyIds.set(def.label, id);
    expected.push({ id, time });
    replyRows.push({
      id,
      authorId: user('author'),
      postId: post(def.post),
      parentCommentId: def.parent ? reply(def.parent) : null,
      content: `${runId} ${def.label}`,
      createdAt: new Date(time),
      updatedAt: new Date(time),
    });
  }
  ordered = expected
    .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
    .map((row) => row.id);
  const deleted = await generateSnowflakeId();
  replyIds.set('deleted', deleted);
  replyRows.push({
    id: deleted,
    authorId: user('author'),
    postId: post('live'),
    content: `${runId} deleted reply`,
    createdAt: now,
    updatedAt: now,
    deletedAt: now,
  });
  const overflow: Array<{ id: string; time: number }> = [];
  for (let i = 0; i < 101; i++) {
    const id = await generateSnowflakeId(),
      time = past.getTime() - i * 1000;
    overflow.push({ id, time });
    replyRows.push({
      id,
      authorId: user('overflow'),
      postId: post('live'),
      content: `${runId} overflow ${i}`,
      createdAt: new Date(time),
      updatedAt: new Date(time),
    });
  }
  overflowOrder = overflow
    .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
    .map((row) => row.id);
  for (const row of await db
    .insert(comments)
    .values(replyRows)
    .returning({ id: comments.id }))
    owned.comments.add(row.id);
  for (const row of await db
    .insert(reactions)
    .values({
      id: await generateSnowflakeId(),
      userId: user('viewer'),
      commentId: reply('newest'),
      type: 'like',
    })
    .returning({ id: reactions.id }))
    owned.reactions.add(row.id);
});

afterAll(async () => {
  const cleanup: Record<
    string,
    { owned: number; removed: number; remaining: number }
  > = {};
  try {
    for (const [kind, table] of [
      ['reactions', reactions],
      ['comments', comments],
      ['posts', posts],
      ['users', users],
    ] as const) {
      const ids = [...owned[kind]],
        removed = ids.length
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
      'PR1688_HTTP_CLEANUP',
      JSON.stringify({
        runId,
        cleanup,
        ownedOnly: true,
        noGlobalRateLimitReset: true,
      })
    );
    await db.$disconnect();
  }
});

describe('actual HTTP public profile reply pagination', () => {
  it('applies explicit page size and excludes deleted and other-author replies from the full total', async () => {
    const body = await page('&limit=3&page=1');
    expect(body.total).toBe(7);
    expect(body.items.map((row) => row.id)).toEqual(ordered.slice(0, 3));
    expect(body.items.map((row) => row.id)).not.toContain(reply('deleted'));
  });
  it('walks disjoint small pages across a tied timestamp boundary', async () => {
    const walked: string[] = [];
    for (let number = 1; number <= 5; number++) {
      const body = await page(`&limit=2&page=${number}`);
      expect(body.total).toBe(7);
      expect(body.items.map((row) => row.id)).toEqual(
        ordered.slice((number - 1) * 2, number * 2)
      );
      walked.push(...body.items.map((row) => row.id));
    }
    expect(walked).toEqual(ordered);
    expect(new Set(walked).size).toBe(7);
    expect(ordered.slice(1, 3)).toEqual(
      [reply('tie-a'), reply('tie-b')].sort().reverse()
    );
  });
  it('retains the true total on partial, beyond-last and empty-author pages', async () => {
    const last = await page('&limit=3&page=3');
    expect(last.total).toBe(7);
    expect(last.items.map((row) => row.id)).toEqual(ordered.slice(6));
    const beyond = await page('&limit=3&page=4');
    expect(beyond.total).toBe(7);
    expect(beyond.items).toEqual([]);
    const empty = await page('', undefined, false, 'other');
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
  });
  it('keeps default100 and makes the101st reply reachable with a full total', async () => {
    const small = await page();
    expect(small.total).toBe(7);
    expect(small.items.map((row) => row.id)).toEqual(ordered);
    const first = await page('', undefined, false, 'overflow');
    expect(first.total).toBe(101);
    expect(first.items.map((row) => row.id)).toEqual(
      overflowOrder.slice(0, 100)
    );
    const tail = await page('&limit=100&page=2', undefined, false, 'overflow');
    expect(tail.total).toBe(101);
    expect(tail.items.map((row) => row.id)).toEqual(overflowOrder.slice(100));
  });
  it('preserves deleted/future parent suppression and live parent enrichment', async () => {
    const body = await page();
    const byId = new Map(body.items.map((row) => [row.id, row]));
    expect(byId.get(reply('deleted-parent'))?.post).toBeNull();
    expect(byId.get(reply('future-parent'))?.post).toBeNull();
    expect(byId.get(reply('deleted-comment-parent'))?.parentComment).toBeNull();
    expect(byId.get(reply('live-comment-parent'))?.parentComment?.id).toBe(
      reply('parent-live')
    );
    expect(byId.get(reply('newest'))?.post?.id).toBe(post('live'));
    expect(JSON.stringify(body)).not.toContain(`${runId} deleted parent`);
    expect(JSON.stringify(body)).not.toContain(`${runId} future parent`);
  });
  it('keeps the public profile target stable while signed viewers get only their own like enrichment', async () => {
    for (const [viewer, cookie, liked] of [
      [undefined, false, false],
      ['viewer', false, true],
      ['viewer', true, true],
      ['other', false, false],
    ] as const) {
      const body = await page(
        `&limit=1&userId=${user('other')}`,
        viewer,
        cookie
      );
      expect(body.total).toBe(7);
      expect(body.items.map((row) => row.id)).toEqual([reply('newest')]);
      expect(body.items[0]?.isLiked).toBe(liked);
      expect(body.items[0]?.likeCount).toBe(1);
    }
  });
  it('retains validated page and limit without touching a shared limiter bucket', async () => {
    for (const query of [
      '&page=0',
      '&page=1.5',
      '&limit=0',
      '&limit=101',
      '&limit=2.5',
    ]) {
      const response = await request(query);
      expect(response.status).toBe(400);
      await response.arrayBuffer();
    }
    expect((await page('&limit=1')).items).toHaveLength(1);
  });
  it('records no teardown ownership for an actual duplicate-key setup failure', async () => {
    const id = await generateSnowflakeId();
    for (const row of await db
      .insert(users)
      .values({ id, username: `p1688_partial_${id}`, updatedAt: new Date() })
      .returning({ id: users.id }))
      owned.users.add(row.id);
    const failed: string[] = [];
    await expect(
      (async () => {
        const rows = await db
          .insert(users)
          .values({
            id: user('author'),
            username: `p1688_collision_${id}`,
            updatedAt: new Date(),
          })
          .returning({ id: users.id });
        failed.push(...rows.map((row) => row.id));
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(failed).toEqual([]);
    expect(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user('author')))
      ).length
    ).toBe(1);
  });
});

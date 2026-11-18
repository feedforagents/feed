/** PRD §§6.1/12, MVP5: total describes the delivered, moderated reply tree. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  comments,
  db,
  eq,
  inArray,
  posts,
  reactions,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';

// The private client runner additionally pins its exact owned DB and server.
if (process.env.DATABASE_READ_REPLICA_URL?.trim())
  throw new Error('Comment fixture refuses a read replica');
function databaseTarget(value: string | undefined) {
  if (!value) throw new Error('Explicit fixture database URL required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
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
  throw new Error('Comment fixture primary/direct targets differ');
const base =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
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
  throw new Error('Disposable loopback HTTP server required');

const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  reactions: new Set<string>(),
  blocks: new Set<string>(),
  mutes: new Set<string>(),
};
const userIds = new Map<string, string>();
const postIds = new Map<string, string>();
const commentIds = new Map<string, string>();
const tokens = new Map<string, string>();
let clientIp = '';
interface CommentNode {
  id: string;
  userId: string;
  parentCommentId: string | null;
  likeCount: number;
  isLiked: boolean;
  replies: CommentNode[];
}
const nodeSchema: z.ZodType<CommentNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    userId: z.string(),
    parentCommentId: z.string().nullable(),
    likeCount: z.number().int().nonnegative(),
    isLiked: z.boolean(),
    replies: z.array(nodeSchema),
  })
);
const responseSchema = z.object({
  data: z.object({
    comments: z.array(nodeSchema),
    total: z.number().int().nonnegative(),
  }),
});
function id(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error(`Missing owned comment fixture ${label}`);
  return value;
}
const user = (label: string) => id(userIds, label);
const post = (label: string) => id(postIds, label);
const comment = (label: string) => id(commentIds, label);
function flatten(nodes: CommentNode[]): CommentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.replies)]);
}
function headers(viewer?: string, cookie = false) {
  const result: Record<string, string> = { 'x-forwarded-for': clientIp };
  if (viewer) {
    const token = id(tokens, viewer);
    result[cookie ? 'cookie' : 'authorization'] = cookie
      ? `steward-token=${token}`
      : `Bearer ${token}`;
  }
  return result;
}
async function read(label: string, viewer?: string, cookie = false) {
  const response = await fetch(`${base}/api/posts/${post(label)}/comments`, {
    headers: headers(viewer, cookie),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  expect(response.status).toBe(200);
  const body = responseSchema.parse(await response.json());
  const delivered = flatten(body.data.comments);
  expect(new Set(delivered.map((node) => node.id)).size).toBe(delivered.length);
  expect(body.data.total).toBe(delivered.length);
  return { response, body: body.data, delivered };
}
function expectIds(delivered: CommentNode[], labels: string[]) {
  expect(delivered.map((node) => node.id).sort()).toEqual(
    labels.map(comment).sort()
  );
}
async function insertUsers(
  rows: Array<typeof users.$inferInsert>,
  ownership = owned.users
) {
  for (const row of await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id }))
    ownership.add(row.id);
}
async function clean(ownership = owned) {
  // Attempt every acquired table even when another cleanup step fails.
  const operations = [
    () =>
      ownership.reactions.size &&
      db
        .delete(reactions)
        .where(inArray(reactions.id, [...ownership.reactions])),
    () =>
      ownership.blocks.size &&
      db
        .delete(userBlocks)
        .where(inArray(userBlocks.id, [...ownership.blocks])),
    () =>
      ownership.mutes.size &&
      db.delete(userMutes).where(inArray(userMutes.id, [...ownership.mutes])),
    () =>
      ownership.comments.size &&
      db.delete(comments).where(inArray(comments.id, [...ownership.comments])),
    () =>
      ownership.posts.size &&
      db.delete(posts).where(inArray(posts.id, [...ownership.posts])),
    () =>
      ownership.users.size &&
      db.delete(users).where(inArray(users.id, [...ownership.users])),
  ];
  const errors: Error[] = [];
  for (const operation of operations) {
    const [result] = await Promise.allSettled([
      Promise.resolve().then(async () => {
        await operation();
      }),
    ]);
    if (result?.status === 'rejected')
      errors.push(
        result.reason instanceof Error
          ? result.reason
          : new Error('Owned cleanup failed')
      );
  }
  const remaining = await Promise.all([
    ownership.reactions.size
      ? db
          .select({ id: reactions.id })
          .from(reactions)
          .where(inArray(reactions.id, [...ownership.reactions]))
      : [],
    ownership.blocks.size
      ? db
          .select({ id: userBlocks.id })
          .from(userBlocks)
          .where(inArray(userBlocks.id, [...ownership.blocks]))
      : [],
    ownership.mutes.size
      ? db
          .select({ id: userMutes.id })
          .from(userMutes)
          .where(inArray(userMutes.id, [...ownership.mutes]))
      : [],
    ownership.comments.size
      ? db
          .select({ id: comments.id })
          .from(comments)
          .where(inArray(comments.id, [...ownership.comments]))
      : [],
    ownership.posts.size
      ? db
          .select({ id: posts.id })
          .from(posts)
          .where(inArray(posts.id, [...ownership.posts]))
      : [],
    ownership.users.size
      ? db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, [...ownership.users]))
      : [],
  ]);
  for (const rows of remaining) expect(rows).toHaveLength(0);
  if (errors.length)
    throw new AggregateError(errors, 'Owned comment fixture cleanup failed');
  const names = [
    'reactions',
    'blocks',
    'mutes',
    'comments',
    'posts',
    'users',
  ] as const;
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      {
        owned: ownership[name].size,
        remaining: remaining[index]?.length ?? -1,
      },
    ])
  );
}

beforeAll(async () => {
  const run = await generateSnowflakeId();
  const groups = BigInt(run).toString(16).padStart(16, '0').match(/.{4}/g);
  if (!groups || groups.length !== 4)
    throw new Error('Fixture IP allocation failed');
  clientIp = `2001:db8:1696:0:${groups.join(':')}`;
  const now = new Date();
  const rows: Array<typeof users.$inferInsert> = [];
  for (const label of [
    'author',
    'viewer',
    'other',
    'normal',
    'blocked',
    'muted',
    'blocker',
  ]) {
    const value = await generateSnowflakeId();
    userIds.set(label, value);
    rows.push({
      id: value,
      username: `p1696_${label}_${run}`,
      stewardId: `p1696-${value}`,
      updatedAt: now,
    });
  }
  await insertUsers(rows);
  for (const viewer of ['viewer', 'other']) {
    tokens.set(viewer, await createStewardTestToken(`p1696-${user(viewer)}`));
    const response = await fetch(`${base}/api/users/me`, {
      headers: headers(viewer),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    const identity = z
      .object({
        authenticated: z.literal(true),
        user: z.object({ id: z.string() }),
      })
      .parse(await response.json());
    expect(identity.user.id).toBe(user(viewer));
  }
  for (const label of [
    'tree',
    'empty',
    'orphan',
    'deep',
    'all-hidden',
    'moderation',
  ]) {
    const value = await generateSnowflakeId();
    postIds.set(label, value);
    const inserted = await db
      .insert(posts)
      .values({
        id: value,
        authorId: user('author'),
        content: `Owned comment total ${run} ${label}`,
        timestamp: new Date(now.getTime() - 60000),
      })
      .returning({ id: posts.id });
    for (const row of inserted) owned.posts.add(row.id);
    expect(inserted).toHaveLength(1);
  }
  const commentRows: Array<typeof comments.$inferInsert> = [];
  async function add(
    label: string,
    postLabel: string,
    author: string,
    parent: string | null = null,
    hidden = false
  ) {
    const value = await generateSnowflakeId();
    commentIds.set(label, value);
    commentRows.push({
      id: value,
      postId: post(postLabel),
      authorId: user(author),
      parentCommentId: parent,
      content: `Owned ${label} ${run}`,
      createdAt: new Date(now.getTime() - 30000),
      updatedAt: now,
      deletedAt: hidden ? now : null,
    });
    return value;
  }
  const parent = await add('parent', 'tree', 'normal');
  await add('child', 'tree', 'viewer', parent);
  const visible = await add('visible', 'tree', 'normal');
  await add('visible-child', 'tree', 'other', visible);
  await add('orphan', 'orphan', 'normal', await generateSnowflakeId());
  let deepParent: string | null = null;
  for (let n = 0; n < 5; n++)
    deepParent = await add(`deep${n}`, 'deep', 'normal', deepParent);
  await add('deep-visible', 'deep', 'other');
  for (let n = 0; n < 2; n++) {
    const hidden = await add(`hidden${n}`, 'all-hidden', 'normal', null, true);
    await add(`hidden-child${n}`, 'all-hidden', 'other', hidden);
  }
  for (const author of ['normal', 'blocked', 'muted', 'blocker']) {
    const root = await add(`mod-${author}`, 'moderation', author);
    await add(`mod-${author}-child`, 'moderation', 'other', root);
  }
  await add('mod-viewer', 'moderation', 'viewer');
  for (const row of await db
    .insert(comments)
    .values(commentRows)
    .returning({ id: comments.id }))
    owned.comments.add(row.id);
  for (const row of await db
    .insert(userBlocks)
    .values([
      {
        id: await generateSnowflakeId(),
        blockerId: user('viewer'),
        blockedId: user('blocked'),
      },
      {
        id: await generateSnowflakeId(),
        blockerId: user('blocker'),
        blockedId: user('viewer'),
      },
    ])
    .returning({ id: userBlocks.id }))
    owned.blocks.add(row.id);
  for (const row of await db
    .insert(userMutes)
    .values({
      id: await generateSnowflakeId(),
      muterId: user('viewer'),
      mutedId: user('muted'),
    })
    .returning({ id: userMutes.id }))
    owned.mutes.add(row.id);
  for (const row of await db
    .insert(reactions)
    .values({
      id: await generateSnowflakeId(),
      userId: user('viewer'),
      commentId: comment('mod-normal'),
      type: 'like',
    })
    .returning({ id: reactions.id }))
    owned.reactions.add(row.id);
});
afterAll(async () => {
  const cleanup = await clean();
  console.log(
    'PR1696_HTTP_CLEANUP',
    JSON.stringify({
      returnedOwnershipOnly: true,
      noGlobalFlushOrDisconnect: true,
      cleanup,
    })
  );
});

// Restore only an acquired row, including when an HTTP assertion fails.
async function hiddenRead(
  label: string,
  parent: string,
  expected: string[],
  restored: string[]
) {
  const value = comment(parent);
  if (!owned.comments.has(value)) throw new Error('Refusing unowned hide');
  try {
    const updated = await db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(eq(comments.id, value))
      .returning({ id: comments.id });
    expect(updated.map((row) => row.id)).toEqual([value]);
    const page = await read(label);
    expectIds(page.delivered, expected);
  } finally {
    await db
      .update(comments)
      .set({ deletedAt: null })
      .where(eq(comments.id, value));
  }
  expectIds((await read(label)).delivered, restored);
}
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

describe('comment-list delivered total through HTTP', () => {
  it('delivers every reachable equal-timestamp node and public headers', async () => {
    const page = await read('tree');
    expectIds(page.delivered, ['parent', 'child', 'visible', 'visible-child']);
    expect(page.body.total).toBe(4);
    expect(page.response.headers.get('cache-control')).toContain('public');
  });
  it('omits the hidden parent and its live child, then restores both', async () => {
    await hiddenRead(
      'tree',
      'parent',
      ['visible', 'visible-child'],
      ['parent', 'child', 'visible', 'visible-child']
    );
    const [child] = await db
      .select({ deletedAt: comments.deletedAt })
      .from(comments)
      .where(eq(comments.id, comment('child')));
    expect(child?.deletedAt).toBeNull();
  });
  it('omits an otherwise live missing-parent orphan', async () => {
    expectIds((await read('orphan')).delivered, []);
    const rows = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.id, comment('orphan')));
    expect(rows).toHaveLength(1);
  });
  it('reports zero for a genuinely empty comment set', async () => {
    expect((await read('empty')).body.total).toBe(0);
    expect(
      await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.postId, post('empty')))
    ).toHaveLength(0);
  });
  it('omits deeper descendants of a hidden intermediate parent', async () => {
    const all = ['deep0', 'deep1', 'deep2', 'deep3', 'deep4', 'deep-visible'];
    expectIds((await read('deep')).delivered, all);
    await hiddenRead('deep', 'deep1', ['deep0', 'deep-visible'], all);
  });
  it('reports zero when every root is hidden but live children remain', async () => {
    expect((await read('all-hidden')).body.total).toBe(0);
    expect(
      await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.postId, post('all-hidden')))
    ).toHaveLength(4);
  });
  it('counts only the signed viewer tree after all three moderation directions', async () => {
    const page = await read('moderation', 'viewer');
    expectIds(page.delivered, ['mod-normal', 'mod-normal-child', 'mod-viewer']);
    expect(page.response.headers.get('cache-control')).toBe(
      'private, no-store'
    );
    const liked = page.delivered.find(
      (node) => node.id === comment('mod-normal')
    );
    expect(liked?.isLiked).toBe(true);
    expect(liked?.likeCount).toBe(1);
  });
  it('keeps cookie viewer, anonymous and repeated bearer reads independent', async () => {
    const labels = ['normal', 'blocked', 'muted', 'blocker']
      .flatMap((name) => [`mod-${name}`, `mod-${name}-child`])
      .concat('mod-viewer');
    const other = await read('moderation', 'other', true);
    expectIds(other.delivered, labels);
    expect(other.response.headers.get('cache-control')).toBe(
      'private, no-store'
    );
    expect(
      other.delivered.find((node) => node.id === comment('mod-normal'))?.isLiked
    ).toBe(false);
    const anonymous = await read('moderation');
    expectIds(anonymous.delivered, labels);
    expect(anonymous.response.headers.get('cache-control')).toContain('public');
    expect(
      anonymous.delivered.find((node) => node.id === comment('mod-normal'))
        ?.isLiked
    ).toBe(false);
    expectIds((await read('moderation', 'viewer')).delivered, [
      'mod-normal',
      'mod-normal-child',
      'mod-viewer',
    ]);
  });
  it('treats invalid optional credentials as the existing public read', async () => {
    const response = await fetch(`${base}/api/posts/${post('tree')}/comments`, {
      headers: { ...headers(), authorization: 'Bearer invalid-fixture-token' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    const body = responseSchema.parse(await response.json());
    expectIds(flatten(body.data.comments), [
      'parent',
      'child',
      'visible',
      'visible-child',
    ]);
    expect(body.data.total).toBe(4);
    expect(response.headers.get('cache-control')).toContain('public');
  });
  it('keeps a duplicate-key control row outside failed setup ownership', async () => {
    const control = await generateSnowflakeId();
    await insertUsers([
      {
        id: control,
        username: `p1696_control_${control}`,
        updatedAt: new Date(),
      },
    ]);
    const subject = {
      users: new Set<string>(),
      posts: new Set<string>(),
      comments: new Set<string>(),
      reactions: new Set<string>(),
      blocks: new Set<string>(),
      mutes: new Set<string>(),
    };
    let partial = '';
    try {
      partial = await generateSnowflakeId();
      await insertUsers(
        [
          {
            id: partial,
            username: `p1696_partial_${partial}`,
            updatedAt: new Date(),
          },
        ],
        subject.users
      );
      const partialPost = await generateSnowflakeId();
      for (const row of await db
        .insert(posts)
        .values({
          id: partialPost,
          authorId: partial,
          content: 'Owned failed setup',
          timestamp: new Date(),
        })
        .returning({ id: posts.id }))
        subject.posts.add(row.id);
      for (const row of await db
        .insert(comments)
        .values({
          id: await generateSnowflakeId(),
          postId: partialPost,
          authorId: partial,
          content: 'Owned failed setup child',
          updatedAt: new Date(),
        })
        .returning({ id: comments.id }))
        subject.comments.add(row.id);
      let collision = false;
      try {
        await insertUsers(
          [
            {
              id: control,
              username: `p1696_conflict_${control}`,
              updatedAt: new Date(),
            },
          ],
          subject.users
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        collision = true;
      }
      expect(collision).toBe(true);
      expect(subject.users.has(control)).toBe(false);
    } finally {
      await clean(subject);
    }
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, partial))
    ).toHaveLength(0);
    const rows = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, control));
    expect(rows).toEqual([{ username: `p1696_control_${control}` }]);
  });
});

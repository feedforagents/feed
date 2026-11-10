/** PRD §12 / MVP phases3/5: canonical notification target visibility. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
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
  !['127.0.0.1', 'localhost'].includes(target.hostname)
)
  throw new Error('Disposable loopback HTTP server required');
const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  notifications: new Set<string>(),
  blocks: new Set<string>(),
  mutes: new Set<string>(),
};
const userIds = new Map<string, string>(),
  postIds = new Map<string, string>(),
  commentIds = new Map<string, string>(),
  tokens = new Map<string, string>();
const fixture = new Map<
  string,
  { id: string; userId: string; time: number; read: boolean; visible: boolean }
>();
let runId = '';
let fixtureTime = 0;
const itemSchema = z.object({
  id: z.string(),
  type: z.string(),
  postId: z.string().nullable(),
  commentId: z.string().nullable(),
  read: z.boolean(),
  message: z.string(),
  data: z
    .object({
      postId: z.string().optional(),
      commentId: z.string().optional(),
    })
    .passthrough()
    .nullable(),
});
const responseSchema = z.object({
  notifications: z.array(itemSchema),
  unreadCount: z.number().int().nonnegative(),
});
function from(map: Map<string, string>, label: string) {
  const value = map.get(label);
  if (!value) throw new Error('Missing fixture ' + label);
  return value;
}
const user = (label: string) => from(userIds, label),
  post = (label: string) => from(postIds, label),
  comment = (label: string) => from(commentIds, label);
function notification(label: string) {
  const value = fixture.get(label);
  if (!value) throw new Error('Missing notification ' + label);
  return value;
}
function auth(label = 'viewer', cookie = false): Record<string, string> {
  const token = from(tokens, label);
  return cookie
    ? { cookie: `steward-token=${token}` }
    : { authorization: `Bearer ${token}` };
}
async function request(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: object
) {
  return fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}
async function list(label = 'viewer', query = '', cookie = false) {
  const response = await request(
    '/api/notifications' + query,
    auth(label, cookie)
  );
  expect(response.status).toBe(200);
  return responseSchema.parse(await response.json());
}
function expected(unreadOnly = false) {
  return [...fixture.values()]
    .filter(
      (row) =>
        row.userId === user('viewer') &&
        row.visible &&
        (!unreadOnly || !row.read)
    )
    .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
    .map((row) => row.id);
}
async function write(
  path: string,
  label: string,
  body: object,
  method = 'PATCH'
) {
  const response = await request(path, auth(label), method, body);
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}
async function addNotification(
  label: string,
  values: Omit<
    typeof notifications.$inferInsert,
    'id' | 'userId' | 'title' | 'message' | 'createdAt'
  >,
  options: { recipient?: string; ago: number; visible: boolean }
) {
  const id = await generateSnowflakeId(),
    userId = user(options.recipient ?? 'viewer'),
    time = fixtureTime - 60000 - options.ago * 1000;
  const rows = await db
    .insert(notifications)
    .values({
      id,
      userId,
      title: 'Notification fixture',
      message: `${runId} ${label}`,
      createdAt: new Date(time),
      ...values,
    })
    .returning({ id: notifications.id });
  for (const row of rows) owned.notifications.add(row.id);
  fixture.set(label, {
    id,
    userId,
    time,
    read: values.read ?? false,
    visible: options.visible,
  });
}
beforeAll(async () => {
  runId = await generateSnowflakeId();
  fixtureTime = Date.now();
  const labels = [
    'viewer',
    'other',
    'actor',
    'blocked',
    'muted',
    'blocker',
    'warm',
  ];
  const rows: Array<typeof users.$inferInsert> = [];
  for (const label of labels) {
    const id = await generateSnowflakeId();
    userIds.set(label, id);
    rows.push({
      id,
      username: `p1686_${label}_${runId.slice(-10)}`,
      displayName: 'Notification fixture ' + label,
      stewardId: `p1686-${id}`,
      updatedAt: new Date(),
    });
  }
  const inserted = await db
    .insert(users)
    .values(rows)
    .returning({ id: users.id });
  for (const row of inserted) owned.users.add(row.id);
  for (const label of ['viewer', 'other', 'actor', 'warm'])
    tokens.set(label, await createStewardTestToken(`p1686-${user(label)}`));
  for (const [label, deleted, future] of [
    ['live', false, false],
    ['deleted', true, false],
    ['gone', false, false],
    ['future', false, true],
    ['warm', false, false],
  ] as const) {
    const id = await generateSnowflakeId();
    postIds.set(label, id);
    const rows = await db
      .insert(posts)
      .values({
        id,
        authorId: user('actor'),
        content: `${runId} ${label} post`,
        timestamp: new Date(Date.now() + (future ? 86400000 : -1000)),
        createdAt: new Date(),
        deletedAt: deleted ? new Date() : null,
      })
      .returning({ id: posts.id });
    for (const row of rows) owned.posts.add(row.id);
  }
  expect(owned.posts.has(post('gone'))).toBe(true);
  await db.delete(posts).where(eq(posts.id, post('gone')));
  for (const [label, parent, deleted] of [
    ['live', 'live', false],
    ['deleted', 'live', true],
    ['gone', 'live', false],
    ['legacy', 'deleted', false],
  ] as const) {
    const id = await generateSnowflakeId();
    commentIds.set(label, id);
    const rows = await db
      .insert(comments)
      .values({
        id,
        authorId: user('actor'),
        postId: post(parent),
        content: `${runId} ${label} comment`,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: deleted ? new Date() : null,
      })
      .returning({ id: comments.id });
    for (const row of rows) owned.comments.add(row.id);
  }
  expect(owned.comments.has(comment('gone'))).toBe(true);
  await db.delete(comments).where(eq(comments.id, comment('gone')));
  const blocked = await db
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
    .returning({ id: userBlocks.id });
  for (const row of blocked) owned.blocks.add(row.id);
  const muted = await db
    .insert(userMutes)
    .values({
      id: await generateSnowflakeId(),
      muterId: user('viewer'),
      mutedId: user('muted'),
    })
    .returning({ id: userMutes.id });
  for (const row of muted) owned.mutes.add(row.id);
  await addNotification(
    'deleted-post',
    { type: 'reaction', actorId: user('actor'), postId: post('deleted') },
    { ago: 0, visible: false }
  );
  await addNotification(
    'follow',
    { type: 'follow', actorId: user('actor') },
    { ago: 1, visible: true }
  );
  await addNotification(
    'deleted-comment',
    {
      type: 'reply',
      actorId: user('actor'),
      postId: post('live'),
      commentId: comment('deleted'),
    },
    { ago: 2, visible: false }
  );
  await addNotification(
    'live-post',
    { type: 'reaction', actorId: user('actor'), postId: post('live') },
    { ago: 3, visible: true }
  );
  await addNotification(
    'gone-post',
    { type: 'reaction', actorId: user('actor'), postId: post('gone') },
    { ago: 4, visible: false }
  );
  await addNotification(
    'live-comment',
    {
      type: 'reply',
      actorId: user('actor'),
      postId: post('live'),
      commentId: comment('live'),
    },
    { ago: 5, visible: true }
  );
  await addNotification(
    'canonical-deleted-parent',
    {
      type: 'reply',
      actorId: user('actor'),
      postId: post('deleted'),
      commentId: comment('legacy'),
    },
    { ago: 6, visible: false }
  );
  await addNotification(
    'comment-only-legacy',
    {
      type: 'reply',
      actorId: user('actor'),
      postId: null,
      commentId: comment('legacy'),
    },
    { ago: 7, visible: true }
  );
  await addNotification(
    'gone-comment',
    { type: 'reply', actorId: user('actor'), commentId: comment('gone') },
    { ago: 8, visible: false }
  );
  await addNotification(
    'system',
    { type: 'system', actorId: null },
    { ago: 9, visible: true }
  );
  await addNotification(
    'json-only-legacy',
    {
      type: 'system',
      actorId: null,
      data: { postId: post('deleted'), commentId: comment('gone') },
    },
    { ago: 9, visible: true }
  );
  await addNotification(
    'empty-canonical',
    { type: 'system', actorId: null, postId: '', commentId: '' },
    { ago: 9, visible: true }
  );
  await addNotification(
    'future-control',
    { type: 'mention', actorId: user('actor'), postId: post('future') },
    { ago: 12, visible: true }
  );
  await addNotification(
    'read-live',
    {
      type: 'reaction',
      actorId: user('actor'),
      postId: post('live'),
      read: true,
    },
    { ago: 13, visible: true }
  );
  for (const [label, ago] of [
    ['blocked', 14],
    ['muted', 15],
    ['blocker', 16],
  ] as const)
    await addNotification(
      label,
      { type: 'reaction', actorId: user(label), postId: post('live') },
      { ago, visible: false }
    );
  await addNotification(
    'other',
    { type: 'reaction', actorId: user('actor'), postId: post('live') },
    { recipient: 'other', ago: 17, visible: true }
  );
  await addNotification(
    'warm',
    { type: 'reaction', actorId: user('actor'), postId: post('warm') },
    { recipient: 'warm', ago: 18, visible: true }
  );
}, 30000);
afterAll(async () => {
  const cleanup: Record<
    string,
    { inserted: number; removedFromDb: number; remaining: number }
  > = {};
  try {
    for (const label of ['viewer', 'other', 'warm']) {
      const token = tokens.get(label);
      if (!token) continue;
      const ids = [...fixture.values()]
        .filter(
          (row) => row.userId === user(label) && owned.notifications.has(row.id)
        )
        .map((row) => row.id);
      if (ids.length) {
        const response = await request(
          '/api/notifications',
          auth(label),
          'DELETE',
          { notificationIds: ids }
        );
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    }
  } finally {
    try {
      for (const [kind, table] of [
        ['notifications', notifications],
        ['comments', comments],
        ['posts', posts],
        ['blocks', userBlocks],
        ['mutes', userMutes],
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
        cleanup[kind] = {
          inserted: ids.length,
          removedFromDb: removed.length,
          remaining,
        };
        expect(remaining).toBe(0);
      }
    } finally {
      console.log(
        'PR1686_NOTIFICATION_CLEANUP',
        JSON.stringify({
          runId,
          cleanup,
          cacheInvalidation:
            'existing HTTP DELETE scoped to own recipient and exact owned IDs',
        })
      );
      await db.$disconnect();
    }
  }
});
describe('actual HTTP canonical notification visibility', () => {
  it('shares canonical target visibility between list and global unread', async () => {
    const result = await list();
    expect(result.notifications.map((row) => row.id)).toEqual(expected());
    expect(result.notifications).toHaveLength(9);
    expect(result.unreadCount).toBe(8);
    for (const label of [
      'deleted-post',
      'deleted-comment',
      'gone-post',
      'canonical-deleted-parent',
      'gone-comment',
    ])
      expect(JSON.stringify(result)).not.toContain(`${runId} ${label}`);
  });
  it('fills small pages and preserves the existing unique order', async () => {
    const walked: string[] = [];
    for (let page = 1; page <= 6; page++) {
      const result = await list('viewer', `?limit=2&page=${page}`);
      expect(result.unreadCount).toBe(8);
      walked.push(...result.notifications.map((row) => row.id));
      if (page === 1)
        expect(result.notifications.map((row) => row.id)).toEqual([
          notification('follow').id,
          notification('live-post').id,
        ]);
    }
    expect(walked).toEqual(expected());
    expect(new Set(walked).size).toBe(9);
  });
  it('keeps global unread independent of type, page and read-only filtering', async () => {
    for (const query of [
      '?type=system',
      '?type=system&unreadOnly=true',
      '?limit=1&page=3&type=reaction',
    ]) {
      const result = await list('viewer', query);
      expect(result.unreadCount).toBe(8);
    }
    const unread = await list('viewer', '?unreadOnly=true');
    expect(unread.notifications.map((row) => row.id)).toEqual(expected(true));
    expect(unread.notifications.every((row) => !row.read)).toBe(true);
  });
  it('retains existing null/empty/JSON-only/parent and future boundaries', async () => {
    const result = await list();
    const empty = result.notifications.find(
      (row) => row.id === notification('empty-canonical').id
    );
    expect(empty?.postId).toBeNull();
    expect(empty?.commentId).toBeNull();
    const legacy = result.notifications.find(
      (row) => row.id === notification('json-only-legacy').id
    );
    expect(legacy?.data?.postId).toBe(post('deleted'));
    expect(legacy?.postId).toBeNull();
    expect(result.notifications.map((row) => row.id)).toContain(
      notification('comment-only-legacy').id
    );
    expect(result.notifications.map((row) => row.id)).not.toContain(
      notification('canonical-deleted-parent').id
    );
    expect(result.notifications.map((row) => row.id)).toContain(
      notification('future-control').id
    );
  });
  it('retains both-direction block/mute filtering and changes a warm moderation key', async () => {
    const rows = await db
      .insert(userBlocks)
      .values({
        id: await generateSnowflakeId(),
        blockerId: user('viewer'),
        blockedId: user('actor'),
      })
      .returning({ id: userBlocks.id });
    for (const row of rows) owned.blocks.add(row.id);
    try {
      const result = await list();
      expect(result.notifications.map((row) => row.id).sort()).toEqual(
        ['system', 'json-only-legacy', 'empty-canonical']
          .map((label) => notification(label).id)
          .sort()
      );
      expect(result.unreadCount).toBe(3);
    } finally {
      for (const row of rows)
        await db.delete(userBlocks).where(eq(userBlocks.id, row.id));
    }
    expect((await list()).unreadCount).toBe(8);
  });
  it('binds normal Bearer/cookie identity and prevents recipient spoofing', async () => {
    for (const cookie of [false, true]) {
      const response = await request('/api/users/me', auth('viewer', cookie));
      expect(response.status).toBe(200);
      expect(
        z
          .object({ user: z.object({ id: z.string() }) })
          .parse(await response.json()).user.id
      ).toBe(user('viewer'));
    }
    const other = await list('other', `?userId=${user('viewer')}`);
    expect(other.notifications.map((row) => row.id)).toEqual([
      notification('other').id,
    ]);
    expect(other.unreadCount).toBe(1);
    for (const headers of [
      {},
      { authorization: 'Bearer invalid-token' },
    ] as Array<Record<string, string>>) {
      const response = await request('/api/notifications', headers);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
  });
  it('keeps mark/read and clear requests scoped to the authenticated owner', async () => {
    await write('/api/notifications', 'viewer', {
      notificationIds: [notification('other').id],
    });
    const [other] = await db
      .select({ read: notifications.read })
      .from(notifications)
      .where(eq(notifications.id, notification('other').id));
    expect(other?.read).toBe(false);
    await write(
      '/api/notifications',
      'viewer',
      { notificationIds: [notification('other').id] },
      'DELETE'
    );
    expect(
      (
        await db
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.id, notification('other').id))
      ).length
    ).toBe(1);
    expect((await list('other')).unreadCount).toBe(1);
  });
  it('does not acquire teardown ownership from a failed colliding insert', async () => {
    const id = await generateSnowflakeId();
    const rows = await db
      .insert(users)
      .values({ id, username: `p1686_partial_${id}`, updatedAt: new Date() })
      .returning({ id: users.id });
    for (const row of rows) owned.users.add(row.id);
    const failed: string[] = [];
    await expect(
      (async () => {
        const inserted = await db
          .insert(users)
          .values({
            id: user('viewer'),
            username: `p1686_collision_${id}`,
            updatedAt: new Date(),
          })
          .returning({ id: users.id });
        failed.push(...inserted.map((row) => row.id));
      })()
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(failed).toEqual([]);
    expect(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user('viewer')))
      ).length
    ).toBe(1);
  });
  it('drops the badge to zero after visible notifications are read', async () => {
    const visibleIds = expected(true);
    await write('/api/notifications', 'viewer', {
      notificationIds: visibleIds,
    });
    const result = await list();
    expect(result.unreadCount).toBe(0);
    expect(result.notifications.every((row) => row.read)).toBe(true);
    expect((await list('viewer', '?type=system')).unreadCount).toBe(0);
    const hidden = await db
      .select({ read: notifications.read })
      .from(notifications)
      .where(
        inArray(
          notifications.id,
          [
            'deleted-post',
            'deleted-comment',
            'gone-post',
            'canonical-deleted-parent',
            'gone-comment',
          ].map((label) => notification(label).id)
        )
      );
    expect(hidden.every((row) => !row.read)).toBe(true);
  });
  it('honors real warm-cache staleness then filters an actually deleted target after expiry', async () => {
    const cold = await list('warm', '?limit=5');
    expect(cold.notifications.map((row) => row.id)).toEqual([
      notification('warm').id,
    ]);
    expect(cold.unreadCount).toBe(1);
    const before = await request(`/api/posts/${post('warm')}`, auth('warm'));
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    const deletion = await request(
      `/api/posts/${post('warm')}`,
      auth('actor'),
      'DELETE'
    );
    expect(deletion.status).toBe(200);
    await deletion.arrayBuffer();
    const hidden = await request(`/api/posts/${post('warm')}`, auth('warm'));
    expect(hidden.status).toBe(400);
    await hidden.arrayBuffer();
    const warm = await list('warm', '?limit=5');
    expect(warm.notifications.map((row) => row.id)).toEqual([
      notification('warm').id,
    ]);
    expect(warm.unreadCount).toBe(1);
    const started = performance.now();
    await Bun.sleep(11000);
    const elapsed = performance.now() - started;
    const fresh = await list('warm', '?limit=5');
    expect(fresh.notifications).toEqual([]);
    expect(fresh.unreadCount).toBe(0);
    console.log(
      'PR1686_REAL_CACHE_EXPIRY',
      JSON.stringify({
        runId,
        elapsedMs: Math.round(elapsed),
        clockControlled: false,
        backend:
          'production server configured cache; worker records configured backend separately',
        warmCount: warm.notifications.length,
        freshCount: fresh.notifications.length,
      })
    );
  }, 30000);
});

/**
 * Notification target visibility on the agent surfaces (PRD §8.1/§12,
 * MVP phases 3/5): the MCP get_notifications list, the MCP
 * get_unread_count, and the A2A messaging.get_notifications list and its
 * unread tally, against a real database.
 *
 * The web notification list (GET /api/notifications) applies the canonical
 * target rule — a notification whose postId names a post that no longer
 * exists or is soft-deleted is hidden, likewise for a commentId, and its
 * unread count shares the condition (spec:
 * notifications-deleted-content.integration.test.ts). The agent surfaces
 * applied no target condition at all: a notification pointing at a deleted
 * post or comment stayed in the MCP and A2A lists, and both agent unread
 * counts included it, so the same user was told 12 unread by MCP and 9 by
 * A2A where the website said 7.
 *
 * Actor moderation is a separate axis and is not what this test pins: the
 * MCP list keeps blocked/muted actors' rows here (that filter is owned by
 * the open MCP notification-list change), while A2A already applies it.
 * Test and banned actors' notifications are returned by every surface,
 * including the web list, and stay returned.
 *
 * A second recipient carries a representative 120-row history (half live,
 * half dead targets) so the count and page shape are measured at scale,
 * not only on the 14-row fixture. Teardown registers every acquired row
 * immediately and deletes only exact acquired IDs under parent locks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  closeDatabase,
  comments,
  db,
  eq,
  gameOnboarding,
  inArray,
  notInArray,
  notifications,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as webGetNotifications } from '../../../apps/web/src/app/api/notifications/route';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';
import {
  executeGetNotifications,
  executeGetUnreadCount,
} from '../../mcp/src/handlers/tool-handlers';

const T0 = 1_700_000_000_000;
const BULK_LIVE = 60;
const BULK_DEAD = 60;
const ownedUsers: string[] = [];
const ownedNotifications: string[] = [];
const ownedPosts: string[] = [];
const ownedComments: string[] = [];
const ownedBlocks: string[] = [];
const ownedMutes: string[] = [];
const labelOf = new Map<string, string>();

let recipient: string;
let bulk: string;
const bulkLabels = new Map<string, string>();
let control: string;
const controlLabels = new Map<string, string>();

async function mkUser(label: string, extra: Record<string, unknown> = {}) {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `ndt_${label}_${id.slice(-6)}`,
    updatedAt: new Date(),
    ...extra,
  });
  ownedUsers.push(id);
  return id;
}

type NotificationFixture = {
  type: 'like' | 'system';
  actorId?: string | null;
  read?: boolean;
  postId?: string;
  commentId?: string;
};

async function mkNotification(
  userId: string,
  labels: Map<string, string>,
  label: string,
  values: NotificationFixture,
  idx: number
) {
  const id = await generateSnowflakeId();
  await db.insert(notifications).values({
    id,
    userId,
    title: 'deleted-target fixture',
    message: `ndt ${label}`,
    createdAt: new Date(T0 + idx * 1000),
    ...values,
  });
  ownedNotifications.push(id);
  labels.set(id, label);
  return id;
}

function labelsOf(ids: string[], labels: Map<string, string>): string[] {
  return ids.map((id) => labels.get(id) ?? id).sort();
}

async function webList(userId: string) {
  const req = new NextRequest(
    'http://127.0.0.1:3100/api/notifications?limit=100&page=1',
    { headers: { 'x-dev-user-id': userId } }
  );
  const res = await webGetNotifications(req);
  const body = (await res.json()) as {
    notifications: Array<{ id: string }>;
    unreadCount: number;
  };
  return body;
}

const agent = (userId: string) => ({ agentId: 'agent', userId }) as never;

beforeAll(async () => {
  recipient = await mkUser('recipient');
  const normal = await mkUser('normal');
  const blockedA = await mkUser('blocked');
  const mutedA = await mkUser('muted');
  const blockerA = await mkUser('blocker');
  const testFlag = await mkUser('testflag', { isTest: true });
  const testPrefixId = `test-ndt-${Date.now()}`;
  await db.insert(users).values({
    id: testPrefixId,
    username: `ndt_testprefix_${testPrefixId.slice(-6)}`,
    updatedAt: new Date(),
  });
  ownedUsers.push(testPrefixId);
  const bannedA = await mkUser('banned', { isBanned: true });

  const livePostId = await generateSnowflakeId();
  await db.insert(posts).values({
    id: livePostId,
    authorId: normal,
    content: 'ndt live post',
    timestamp: new Date(),
    createdAt: new Date(),
    deletedAt: null,
  });
  ownedPosts.push(livePostId);
  const deletedPostId = await generateSnowflakeId();
  await db.insert(posts).values({
    id: deletedPostId,
    authorId: normal,
    content: 'ndt deleted post',
    timestamp: new Date(),
    createdAt: new Date(),
    deletedAt: new Date(),
  });
  ownedPosts.push(deletedPostId);
  const gonePostId = await generateSnowflakeId();
  await db.insert(posts).values({
    id: gonePostId,
    authorId: normal,
    content: 'ndt gone post',
    timestamp: new Date(),
    createdAt: new Date(),
    deletedAt: null,
  });
  // Register immediately: if setup fails before the planned hard delete
  // below, afterAll still removes this row.
  ownedPosts.push(gonePostId);

  const liveCommentId = await generateSnowflakeId();
  await db.insert(comments).values({
    id: liveCommentId,
    authorId: normal,
    postId: livePostId,
    content: 'ndt live comment',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
  ownedComments.push(liveCommentId);
  const deletedCommentId = await generateSnowflakeId();
  await db.insert(comments).values({
    id: deletedCommentId,
    authorId: normal,
    postId: livePostId,
    content: 'ndt deleted comment',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: new Date(),
  });
  ownedComments.push(deletedCommentId);

  // Visible rows are the oldest; the dead-target rows are the newest, so a
  // filter applied after the limit would visibly shrink the page.
  let i = 0;
  await mkNotification(
    recipient,
    labelOf,
    'v01-normal',
    { actorId: normal, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v02-normal-read',
    { actorId: normal, type: 'like', read: true },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v03-system',
    { actorId: null, type: 'system' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v04-testflag',
    { actorId: testFlag, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v05-testprefix',
    { actorId: testPrefixId, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v06-banned',
    { actorId: bannedA, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v07-blocked',
    { actorId: blockedA, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v08-muted',
    { actorId: mutedA, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v09-blocker',
    { actorId: blockerA, type: 'like' },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v10-live-post',
    { actorId: normal, type: 'like', postId: livePostId },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'v11-live-comment',
    { actorId: normal, type: 'like', commentId: liveCommentId },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'd12-deleted-post',
    { actorId: normal, type: 'like', postId: deletedPostId },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'd13-deleted-comment',
    { actorId: normal, type: 'like', commentId: deletedCommentId },
    i++
  );
  await mkNotification(
    recipient,
    labelOf,
    'd14-gone-post',
    { actorId: normal, type: 'like', postId: gonePostId },
    i++
  );
  // The d14 target is hard-deleted after the notification exists.
  await db.delete(posts).where(eq(posts.id, gonePostId));

  const b1 = await db
    .insert(userBlocks)
    .values({
      id: crypto.randomUUID(),
      blockerId: recipient,
      blockedId: blockedA,
    })
    .returning({ id: userBlocks.id });
  ownedBlocks.push(...b1.map((r) => r.id));
  const b2 = await db
    .insert(userBlocks)
    .values({
      id: crypto.randomUUID(),
      blockerId: blockerA,
      blockedId: recipient,
    })
    .returning({ id: userBlocks.id });
  ownedBlocks.push(...b2.map((r) => r.id));
  const m1 = await db
    .insert(userMutes)
    .values({ id: crypto.randomUUID(), muterId: recipient, mutedId: mutedA })
    .returning({ id: userMutes.id });
  ownedMutes.push(...m1.map((r) => r.id));

  control = await mkUser('control');
  await mkNotification(
    control,
    controlLabels,
    'c1-live-post',
    { actorId: normal, type: 'like', postId: livePostId },
    0
  );
  await mkNotification(
    control,
    controlLabels,
    'c2-plain',
    { actorId: normal, type: 'like' },
    1
  );

  // Representative history for the scaling check: 120 notifications on one
  // user, half pointing at the live post and half at the deleted post,
  // dead-target rows newest, so a filter applied after the limit would
  // shrink the page and skew the count.
  bulk = await mkUser('bulk');
  let j = 1000;
  for (let k = 0; k < BULK_LIVE + BULK_DEAD; k++) {
    const dead = k % 2 === 1;
    await mkNotification(
      bulk,
      bulkLabels,
      dead ? `b-dead-${k}` : `b-live-${k}`,
      {
        actorId: normal,
        type: 'like',
        postId: dead ? deletedPostId : livePostId,
      },
      j++
    );
  }
});

afterAll(async () => {
  try {
    // Guarded cleanup, all in one transaction: lock the owned parent rows
    // first so no concurrent child can attach while cleanup runs, then
    // check — atomically with the deletes — that no foreign (unacquired)
    // child references them, and only then delete exactly the acquired
    // IDs, children before parents. A foreign child must fail loudly
    // here instead of being cascade-deleted (a separately created
    // GameOnboarding on an acquired user) or orphaned (a comment or
    // repost pointing at an acquired post).
    await db.transaction(async (tx) => {
      if (ownedUsers.length)
        await tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, ownedUsers))
          .for('update');
      if (ownedPosts.length)
        await tx
          .select({ id: posts.id })
          .from(posts)
          .where(inArray(posts.id, ownedPosts))
          .for('update');
      if (ownedComments.length)
        await tx
          .select({ id: comments.id })
          .from(comments)
          .where(inArray(comments.id, ownedComments))
          .for('update');

      if (ownedUsers.length) {
        const foreignOnboarding = await tx
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(inArray(gameOnboarding.userId, ownedUsers));
        if (foreignOnboarding.length > 0)
          throw new Error(
            `refusing cleanup: ${foreignOnboarding.length} GameOnboarding row(s) reference owned users`
          );
      }
      if (ownedPosts.length) {
        const foreignComments = await tx
          .select({ id: comments.id })
          .from(comments)
          .where(
            ownedComments.length > 0
              ? and(
                  inArray(comments.postId, ownedPosts),
                  notInArray(comments.id, ownedComments)
                )
              : inArray(comments.postId, ownedPosts)
          );
        if (foreignComments.length > 0)
          throw new Error(
            `refusing cleanup: ${foreignComments.length} comment(s) reference owned posts`
          );
        const foreignReposts = await tx
          .select({ id: posts.id })
          .from(posts)
          .where(
            and(
              inArray(posts.originalPostId, ownedPosts),
              notInArray(posts.id, ownedPosts)
            )
          );
        if (foreignReposts.length > 0)
          throw new Error(
            `refusing cleanup: ${foreignReposts.length} repost(s) reference owned posts`
          );
      }

      if (ownedNotifications.length)
        await tx
          .delete(notifications)
          .where(inArray(notifications.id, ownedNotifications));
      if (ownedBlocks.length)
        await tx.delete(userBlocks).where(inArray(userBlocks.id, ownedBlocks));
      if (ownedMutes.length)
        await tx.delete(userMutes).where(inArray(userMutes.id, ownedMutes));
      if (ownedComments.length)
        await tx.delete(comments).where(inArray(comments.id, ownedComments));
      if (ownedPosts.length)
        await tx.delete(posts).where(inArray(posts.id, ownedPosts));
      if (ownedUsers.length)
        await tx.delete(users).where(inArray(users.id, ownedUsers));
    });
  } finally {
    await closeDatabase();
  }
});

const WEB_VISIBLE = [
  'v01-normal',
  'v02-normal-read',
  'v03-system',
  'v04-testflag',
  'v05-testprefix',
  'v06-banned',
  'v10-live-post',
  'v11-live-comment',
];

describe('notification target visibility on agent surfaces', () => {
  it('web list is the oracle: dead targets hidden, unread excludes them', async () => {
    const body = await webList(recipient);
    expect(
      labelsOf(
        body.notifications.map((n) => n.id),
        labelOf
      )
    ).toEqual(WEB_VISIBLE);
    expect(body.unreadCount).toBe(7);
  });

  it('MCP list excludes dead-target notifications and nothing else', async () => {
    const result = await executeGetNotifications(agent(recipient), {
      limit: 100,
    } as never);
    expect(
      labelsOf(
        result.notifications.map((n) => n.id),
        labelOf
      )
    ).toEqual([
      'v01-normal',
      'v02-normal-read',
      'v03-system',
      'v04-testflag',
      'v05-testprefix',
      'v06-banned',
      'v07-blocked',
      'v08-muted',
      'v09-blocker',
      'v10-live-post',
      'v11-live-comment',
    ]);
  });

  it('MCP list filters before the limit: newest dead rows do not shrink the page', async () => {
    const result = await executeGetNotifications(agent(recipient), {
      limit: 11,
    } as never);
    expect(result.notifications).toHaveLength(11);
  });

  it('MCP unread count excludes dead-target notifications', async () => {
    const result = await executeGetUnreadCount(agent(recipient), {} as never);
    expect(result.unreadCount).toBe(10);
  });

  it('A2A list and unread tally match the web list exactly', async () => {
    const result = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 50 },
      recipient
    )) as unknown as {
      unreadCount: number;
      notifications: Array<{ id: string }>;
    };
    expect(
      labelsOf(
        result.notifications.map((n) => n.id),
        labelOf
      )
    ).toEqual(WEB_VISIBLE);
    expect(result.unreadCount).toBe(7);
  });

  it('representative history: count and page shape stay exact at 120 rows', async () => {
    const web = await webList(bulk);
    expect(web.notifications).toHaveLength(BULK_LIVE);
    expect(web.unreadCount).toBe(BULK_LIVE);

    const mcpList = await executeGetNotifications(agent(bulk), {
      limit: 10,
    } as never);
    expect(mcpList.notifications).toHaveLength(10);
    for (const n of mcpList.notifications)
      expect(bulkLabels.get(n.id)).toMatch(/^b-live-/);
    const mcpCount = await executeGetUnreadCount(agent(bulk), {} as never);
    expect(mcpCount.unreadCount).toBe(BULK_LIVE);

    const a2a = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 10 },
      bulk
    )) as unknown as {
      unreadCount: number;
      notifications: Array<{ id: string }>;
    };
    expect(a2a.notifications).toHaveLength(10);
    for (const n of a2a.notifications)
      expect(bulkLabels.get(n.id)).toMatch(/^b-live-/);
    expect(a2a.unreadCount).toBe(BULK_LIVE);
  });

  it('control user with only live targets is unchanged on every surface', async () => {
    const web = await webList(control);
    expect(
      labelsOf(
        web.notifications.map((n) => n.id),
        controlLabels
      )
    ).toEqual(['c1-live-post', 'c2-plain']);
    expect(web.unreadCount).toBe(2);

    const mcpList = await executeGetNotifications(agent(control), {
      limit: 100,
    } as never);
    expect(mcpList.notifications).toHaveLength(2);
    const mcpCount = await executeGetUnreadCount(agent(control), {} as never);
    expect(mcpCount.unreadCount).toBe(2);

    const a2a = (await FeedAgentExecutor.executeDirectly(
      'messaging.get_notifications',
      { limit: 50 },
      control
    )) as unknown as {
      unreadCount: number;
      notifications: Array<{ id: string }>;
    };
    expect(a2a.notifications).toHaveLength(2);
    expect(a2a.unreadCount).toBe(2);
  });
});

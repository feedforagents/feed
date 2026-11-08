/**
 * GET /api/notifications against a real database: the web notification
 * list must not show notifications whose linked content the viewer can no
 * longer open.
 *
 * A notification that points at a soft-deleted post is a dead end — the
 * post endpoint errors with POST_DELETED — and a soft-deleted comment is
 * treated exactly like a comment that does not exist (the comment detail
 * route 404s it, per the merged comment-moderation fix). A hard-deleted
 * comment (the author delete endpoint removes the row) is gone outright.
 * Everywhere else the API states the same rule for the same content:
 * visible means not deleted. The list query only excluded blocked/muted
 * actors, so like/reply notifications for moderated-away or deleted
 * content stayed in the list and led nowhere when tapped.
 *
 * Scope note: the unread badge count is intentionally not asserted here;
 * aligning that count query is owned by the open moderation-count PR.
 *
 * The request is authenticated with the dev `x-dev-user-id` bypass
 * (NODE_ENV=test), the same pattern as the game-feedback integration
 * suite. The only stub is the `server-only` marker package; every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type NotificationsResponse = {
  notifications: Array<{
    id: string;
    postId: string | null;
    commentId: string | null;
  }>;
  unreadCount: number;
};

let viewerId: string;
let actorId: string;
let postVisibleId: string;
let postDeletedId: string;
let commentVisibleId: string;
let commentDeletedId: string;
let commentGoneId: string;
const ids = {
  follow: '',
  likeVisiblePost: '',
  likeDeletedPost: '',
  replyVisibleComment: '',
  replyDeletedComment: '',
  likeGoneComment: '',
  system: '',
};
const allNotificationIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/notifications/route').GET;

async function fetchNotifications(query: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/notifications${query}`),
    { headers: { 'x-dev-user-id': viewerId } }
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | NotificationsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/notifications/route'));

  [
    viewerId,
    actorId,
    postVisibleId,
    postDeletedId,
    commentVisibleId,
    commentDeletedId,
    commentGoneId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();

  await db.insert(users).values([
    {
      id: viewerId,
      username: `g1v-${viewerId}`,
      displayName: 'Notif Deleted-Content Viewer',
      updatedAt: now,
    },
    {
      id: actorId,
      username: `g1a-${actorId}`,
      displayName: 'Notif Deleted-Content Actor',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values([
    {
      id: postVisibleId,
      content: 'a visible post',
      authorId: actorId,
      timestamp: now,
      createdAt: now,
    },
    {
      id: postDeletedId,
      content: 'a soft-deleted post',
      authorId: actorId,
      timestamp: now,
      createdAt: now,
      deletedAt: now,
    },
  ]);

  await db.insert(comments).values([
    {
      id: commentVisibleId,
      content: 'a visible comment',
      postId: postVisibleId,
      authorId: actorId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: commentDeletedId,
      content: 'a soft-deleted comment',
      postId: postVisibleId,
      authorId: actorId,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
    {
      id: commentGoneId,
      content: 'a comment the author then hard-deletes',
      postId: postVisibleId,
      authorId: actorId,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  // The author comment-delete endpoint removes the row outright.
  await db.delete(comments).where(eq(comments.id, commentGoneId));

  const rows: Array<{
    key: keyof typeof ids;
    type: string;
    actorId: string | null;
    postId: string | null;
    commentId: string | null;
    minutesAgo: number;
  }> = [
    {
      key: 'follow',
      type: 'follow',
      actorId,
      postId: null,
      commentId: null,
      minutesAgo: 1,
    },
    {
      key: 'likeDeletedPost',
      type: 'like',
      actorId,
      postId: postDeletedId,
      commentId: null,
      minutesAgo: 2,
    },
    {
      key: 'likeVisiblePost',
      type: 'like',
      actorId,
      postId: postVisibleId,
      commentId: null,
      minutesAgo: 3,
    },
    {
      key: 'replyDeletedComment',
      type: 'reply',
      actorId,
      postId: postVisibleId,
      commentId: commentDeletedId,
      minutesAgo: 4,
    },
    {
      key: 'replyVisibleComment',
      type: 'reply',
      actorId,
      postId: postVisibleId,
      commentId: commentVisibleId,
      minutesAgo: 5,
    },
    {
      key: 'likeGoneComment',
      type: 'like',
      actorId,
      postId: null,
      commentId: commentGoneId,
      minutesAgo: 6,
    },
    {
      key: 'system',
      type: 'system',
      actorId: null,
      postId: null,
      commentId: null,
      minutesAgo: 7,
    },
  ];
  for (const row of rows) {
    ids[row.key] = await generateSnowflakeId();
    allNotificationIds.push(ids[row.key]);
    await db.insert(notifications).values({
      id: ids[row.key],
      userId: viewerId,
      type: row.type,
      actorId: row.actorId,
      postId: row.postId,
      commentId: row.commentId,
      title: `fixture ${row.key}`,
      message: `fixture ${row.key}`,
      read: false,
      createdAt: new Date(now.getTime() - row.minutesAgo * 60_000),
    });
  }
});

afterAll(async () => {
  if (!viewerId) return;
  await db
    .delete(notifications)
    .where(inArray(notifications.id, allNotificationIds));
  await db
    .delete(comments)
    .where(
      inArray(comments.id, [commentVisibleId, commentDeletedId, commentGoneId])
    );
  await db
    .delete(posts)
    .where(inArray(posts.id, [postVisibleId, postDeletedId]));
  await db.delete(users).where(inArray(users.id, [viewerId, actorId]));
});

describe('GET /api/notifications with deleted linked content', () => {
  it('lists only notifications whose linked post/comment is still visible', async () => {
    const { status, body } = await fetchNotifications('');
    expect(status).toBe(200);
    expect(body?.notifications.map((n) => n.id)).toEqual([
      ids.follow,
      ids.likeVisiblePost,
      ids.replyVisibleComment,
      ids.system,
    ]);
  });

  it('keeps pages full: hidden rows do not consume page slots', async () => {
    const { status, body } = await fetchNotifications('?limit=2');
    expect(status).toBe(200);
    expect(body?.notifications.map((n) => n.id)).toEqual([
      ids.follow,
      ids.likeVisiblePost,
    ]);
  });
});

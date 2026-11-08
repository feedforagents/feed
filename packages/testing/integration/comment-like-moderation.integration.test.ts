/**
 * POST /api/comments/[id]/like against a real database: a comment that
 * moderation soft-deleted must not be likable.
 *
 * The sibling post like route states the rule for the same action on a
 * post: a soft-deleted post rejects a new like ("Cannot like deleted
 * post", POST_DELETED) while an existing like can still be removed. The
 * comment list route states why: "Soft-deleted (moderated) comments must
 * never be returned" — the comment is hidden everywhere, and the comment
 * detail route no longer returns it either. The comment like route never
 * looked at `deletedAt`, so a hidden comment could still collect a like,
 * raise its like count, and send its author a "liked your comment"
 * notification.
 *
 * The request is authenticated with the non-production x-dev-user-id
 * header. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  and,
  comments,
  db,
  eq,
  inArray,
  notifications,
  posts,
  reactions,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let likerId: string;
let authorId: string;
let postId: string;
let visibleCommentId: string;
let deletedCommentId: string;
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];

let DELETE: typeof import('../../../apps/web/src/app/api/comments/[id]/like/route').DELETE;
let POST: typeof import('../../../apps/web/src/app/api/comments/[id]/like/route').POST;

async function likeComment(
  commentId: string,
  method: 'POST' | 'DELETE' = 'POST'
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/comments/${commentId}/like`, {
      method,
    }),
    { headers: { 'x-dev-user-id': likerId } }
  );
  const response = await (method === 'POST' ? POST : DELETE)(request, {
    params: Promise.resolve({ id: commentId }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { likeCount: number; isLiked: boolean };
    error?: string;
    code?: string;
  } | null;
  return { status: response.status, body };
}

async function likeRows(commentId: string) {
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(and(eq(reactions.commentId, commentId), eq(reactions.type, 'like')));
}

async function reactionNotifications(commentId: string) {
  return db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, authorId),
        eq(notifications.commentId, commentId),
        eq(notifications.type, 'reaction')
      )
    );
}

beforeAll(async () => {
  ({ POST, DELETE } = await import(
    '../../../apps/web/src/app/api/comments/[id]/like/route'
  ));

  [likerId, authorId, postId, visibleCommentId, deletedCommentId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  await db.insert(users).values([
    {
      id: likerId,
      username: `test-f12-liker-${likerId}`,
      displayName: 'Comment Like Fixture Liker',
      updatedAt: now,
    },
    {
      id: authorId,
      username: `test-f12-author-${authorId}`,
      displayName: 'Comment Like Fixture Author',
      updatedAt: now,
    },
  ]);

  ownedUserIds.push(likerId, authorId);

  await db.insert(posts).values({
    id: postId,
    content: 'Fixture post for comment like moderation test',
    authorId,
    timestamp: past,
    createdAt: past,
  });

  ownedPostIds.push(postId);

  // One comment anyone can see, and one moderation soft-deleted comment
  // (deletedAt set) on the same post by the same author.
  await db.insert(comments).values([
    {
      id: visibleCommentId,
      content: 'A visible fixture comment',
      postId,
      authorId,
      createdAt: past,
      updatedAt: past,
    },
    {
      id: deletedCommentId,
      content: 'A soft-deleted fixture comment',
      postId,
      authorId,
      createdAt: past,
      updatedAt: past,
      deletedAt: now,
    },
  ]);
  ownedCommentIds.push(visibleCommentId, deletedCommentId);
});

afterAll(async () => {
  // Generated IDs are not ownership: a failed insert may have collided with
  // an existing row. Only clean batches whose atomic insert succeeded.
  if (ownedCommentIds.length > 0) {
    await db
      .delete(notifications)
      .where(inArray(notifications.commentId, ownedCommentIds));
    await db
      .delete(reactions)
      .where(inArray(reactions.commentId, ownedCommentIds));
    await db.delete(comments).where(inArray(comments.id, ownedCommentIds));
  }
  if (ownedPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('POST /api/comments/[id]/like moderation', () => {
  it('still likes a visible comment and notifies its author', async () => {
    const { status, body } = await likeComment(visibleCommentId);
    expect(status).toBe(201);
    expect(body?.data?.isLiked).toBe(true);
    expect(body?.data?.likeCount).toBe(1);
    expect(await likeRows(visibleCommentId)).toHaveLength(1);
    expect(await reactionNotifications(visibleCommentId)).toHaveLength(1);
    const repeated = await likeComment(visibleCommentId);
    expect(repeated.status).toBe(400);
    expect(repeated.body?.error).toBe('Comment already liked');
    expect(repeated.body?.code).toBe(
      process.env.NODE_ENV === 'development' ? 'ALREADY_LIKED' : undefined
    );
    expect(await likeRows(visibleCommentId)).toHaveLength(1);
    expect(await reactionNotifications(visibleCommentId)).toHaveLength(1);
  });

  it('rejects a like on a soft-deleted comment and creates nothing', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { status, body } = await likeComment(deletedCommentId);
      expect(status).toBe(400);
      expect(body?.error).toBe('Cannot like deleted comment');
      expect(body?.code).toBe(
        process.env.NODE_ENV === 'development' ? 'COMMENT_DELETED' : undefined
      );
    }
    expect(await likeRows(deletedCommentId)).toHaveLength(0);
    expect(await reactionNotifications(deletedCommentId)).toHaveLength(0);
  });
  it('allows an existing like to be removed after moderation without re-liking', async () => {
    const commentId = await generateSnowflakeId();
    await db.insert(comments).values({
      id: commentId,
      postId,
      authorId,
      content: 'Comment moderated after a like',
      updatedAt: new Date(),
    });
    try {
      expect((await likeComment(commentId)).status).toBe(201);
      await db
        .update(comments)
        .set({ deletedAt: new Date() })
        .where(eq(comments.id, commentId));
      const rejected = await likeComment(commentId);
      expect(rejected.status).toBe(400);
      expect(rejected.body?.error).toBe('Cannot like deleted comment');
      expect(rejected.body?.code).toBe(
        process.env.NODE_ENV === 'development' ? 'COMMENT_DELETED' : undefined
      );
      expect(await likeRows(commentId)).toHaveLength(1);
      const removed = await likeComment(commentId, 'DELETE');
      expect(removed.status).toBe(200);
      expect(removed.body?.data?.isLiked).toBe(false);
      expect(removed.body?.data?.likeCount).toBe(0);
      expect(await likeRows(commentId)).toHaveLength(0);
      expect((await likeComment(commentId, 'DELETE')).status).toBe(404);
      expect((await likeComment(commentId)).body?.error).toBe(
        'Cannot like deleted comment'
      );
      expect(await reactionNotifications(commentId)).toHaveLength(1);
    } finally {
      await db
        .delete(notifications)
        .where(eq(notifications.commentId, commentId));
      await db.delete(reactions).where(eq(reactions.commentId, commentId));
      await db.delete(comments).where(eq(comments.id, commentId));
    }
  });

  it('keeps a missing comment distinct from a deleted comment', async () => {
    const missingId = await generateSnowflakeId();
    expect((await likeComment(missingId)).status).toBe(404);
    expect(await likeRows(missingId)).toHaveLength(0);
    expect(await reactionNotifications(missingId)).toHaveLength(0);
  });
});

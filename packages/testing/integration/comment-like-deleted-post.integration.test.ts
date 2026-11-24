/**
 * POST /api/comments/[id]/like against a real database: a comment whose
 * parent post was soft-deleted must not collect a new like.
 *
 * The post like route rejects a new like on a deleted post
 * ("Cannot like deleted post", POST_DELETED) while an existing like can
 * still be removed, and the reply/share/comment-create routes reject
 * writes on deleted posts the same way. The comment like route only
 * looks at the comment's own deletedAt, so a comment on a deleted post
 * can still collect a like.
 *
 * The like is not invisible: the comment stays listed on its author's
 * profile replies tab (the parent renders as post: null, but the reply
 * row keeps its likeCount and like button) and on the comment permalink
 * (/comment/[id]), which returns the comment regardless of the parent
 * post's deletedAt. A like created after the deletion therefore raises
 * a publicly visible like count on a thread that no longer exists.
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
  count,
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
let deletedPostId: string;
let livePostId: string;
let commentOnDeletedPostId: string;
let secondCommentOnDeletedPostId: string;
let commentOnLivePostId: string;
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

/** The like count the profile replies tab and the comment permalink show. */
async function visibleLikeCount(commentId: string) {
  const [row] = await db
    .select({ value: count() })
    .from(reactions)
    .where(and(eq(reactions.commentId, commentId), eq(reactions.type, 'like')));
  return Number(row?.value ?? 0);
}

beforeAll(async () => {
  ({ POST, DELETE } = await import(
    '../../../apps/web/src/app/api/comments/[id]/like/route'
  ));

  [
    likerId,
    authorId,
    deletedPostId,
    livePostId,
    commentOnDeletedPostId,
    secondCommentOnDeletedPostId,
    commentOnLivePostId,
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
  const past = new Date(now.getTime() - 10 * 60_000);

  await db.insert(users).values([
    {
      id: likerId,
      username: `test-xvc-liker-${likerId}`,
      displayName: 'Comment Like Fixture Liker',
      updatedAt: now,
    },
    {
      id: authorId,
      username: `test-xvc-author-${authorId}`,
      displayName: 'Comment Like Fixture Author',
      updatedAt: now,
    },
  ]);

  ownedUserIds.push(likerId, authorId);

  await db.insert(posts).values([
    {
      id: deletedPostId,
      content: 'Fixture post for deleted-post comment like test',
      authorId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: livePostId,
      content: 'Fixture live post for deleted-post comment like test',
      authorId,
      timestamp: past,
      createdAt: past,
    },
  ]);

  ownedPostIds.push(deletedPostId, livePostId);

  await db.insert(comments).values([
    {
      id: commentOnDeletedPostId,
      content: 'A comment on the post that will be deleted',
      postId: deletedPostId,
      authorId,
      createdAt: past,
      updatedAt: past,
    },
    {
      id: secondCommentOnDeletedPostId,
      content: 'A second comment on the post that will be deleted',
      postId: deletedPostId,
      authorId,
      createdAt: past,
      updatedAt: past,
    },
    {
      id: commentOnLivePostId,
      content: 'A comment on the live post',
      postId: livePostId,
      authorId,
      createdAt: past,
      updatedAt: past,
    },
  ]);
  ownedCommentIds.push(
    commentOnDeletedPostId,
    secondCommentOnDeletedPostId,
    commentOnLivePostId
  );

  // Delete the parent post after the comments exist, as a user would.
  await db
    .update(posts)
    .set({ deletedAt: now })
    .where(eq(posts.id, deletedPostId));
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

describe('POST /api/comments/[id]/like on a deleted parent post', () => {
  it('still likes a comment on a live post', async () => {
    const { status, body } = await likeComment(commentOnLivePostId);
    expect(status).toBe(201);
    expect(body?.data?.isLiked).toBe(true);
    expect(body?.data?.likeCount).toBe(1);
    expect(await likeRows(commentOnLivePostId)).toHaveLength(1);
    expect(await reactionNotifications(commentOnLivePostId)).toHaveLength(1);
    expect(await visibleLikeCount(commentOnLivePostId)).toBe(1);
  });

  it('rejects a like on a comment whose parent post is deleted and creates nothing', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { status, body } = await likeComment(commentOnDeletedPostId);
      expect(status).toBe(400);
      expect(body?.error).toBe('Cannot like comment on deleted post');
      expect(body?.code).toBe(
        process.env.NODE_ENV === 'development' ? 'POST_DELETED' : undefined
      );
    }
    expect(await likeRows(commentOnDeletedPostId)).toHaveLength(0);
    expect(await reactionNotifications(commentOnDeletedPostId)).toHaveLength(0);
    expect(await visibleLikeCount(commentOnDeletedPostId)).toBe(0);
  });

  it('allows an existing like to be removed after the parent post is deleted without re-liking', async () => {
    // Like while the post is live is covered by the sibling test file;
    // here the like predates the deletion: insert it directly, then the
    // post is already deleted by the fixture setup.
    const reactionId = await generateSnowflakeId();
    await db.insert(reactions).values({
      id: reactionId,
      commentId: secondCommentOnDeletedPostId,
      userId: likerId,
      type: 'like',
    });
    try {
      expect(await likeRows(secondCommentOnDeletedPostId)).toHaveLength(1);
      const removed = await likeComment(secondCommentOnDeletedPostId, 'DELETE');
      expect(removed.status).toBe(200);
      expect(removed.body?.data?.isLiked).toBe(false);
      expect(removed.body?.data?.likeCount).toBe(0);
      expect(await likeRows(secondCommentOnDeletedPostId)).toHaveLength(0);
      const relike = await likeComment(secondCommentOnDeletedPostId);
      expect(relike.status).toBe(400);
      expect(relike.body?.error).toBe('Cannot like comment on deleted post');
      expect(await likeRows(secondCommentOnDeletedPostId)).toHaveLength(0);
    } finally {
      await db
        .delete(reactions)
        .where(eq(reactions.commentId, secondCommentOnDeletedPostId));
    }
  });
});

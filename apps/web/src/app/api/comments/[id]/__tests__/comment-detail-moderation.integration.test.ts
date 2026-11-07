/**
 * GET /api/comments/[id] against a real database: content that moderation
 * soft-deleted (comments.deletedAt set by the admin content queue "hide"
 * action) must not be reachable through the comment permalink.
 *
 * The post comment list already enforces this ("Soft-deleted (moderated)
 * comments must never be returned"), and every sibling read path filters
 * deletedAt. The detail route is exercised unmodified; the request is
 * anonymous (optionalAuth returns null without a token), so no module is
 * mocked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { comments, db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type CommentDetailResponse = {
  comment: {
    id: string;
    content: string;
    replyCount: number;
  };
  replies: Array<{ id: string; content: string }>;
  parentChain: Array<{ id: string; content: string }>;
  post: { id: string; commentCount: number } | null;
};

let authorA: string;
let authorB: string;
let postId: string;
let visibleCommentId: string;
let deletedCommentId: string;
let visibleReplyId: string;
let deletedReplyId: string;
let childOfDeletedId: string;
const allCommentIds: string[] = [];

let GET: typeof import('../route').GET;

async function fetchComment(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/comments/${id}`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../route'));

  [authorA, authorB, postId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  [
    visibleCommentId,
    deletedCommentId,
    visibleReplyId,
    deletedReplyId,
    childOfDeletedId,
  ] = await Promise.all(Array.from({ length: 5 }, () => generateSnowflakeId()));
  allCommentIds.push(
    visibleCommentId,
    deletedCommentId,
    visibleReplyId,
    deletedReplyId,
    childOfDeletedId
  );

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: authorA,
      username: `test-cmt-a-${authorA}`,
      displayName: 'Comment Fixture A',
      updatedAt: now,
    },
    {
      id: authorB,
      username: `test-cmt-b-${authorB}`,
      displayName: 'Comment Fixture B',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values({
    id: postId,
    content: 'fixture post',
    authorId: authorA,
    timestamp: earlier,
    createdAt: earlier,
  });

  // A visible top-level comment, a moderation-hidden (soft-deleted)
  // top-level comment, one visible and one hidden reply under the visible
  // comment, and a visible reply under the hidden comment.
  await db.insert(comments).values([
    {
      id: visibleCommentId,
      content: 'visible parent comment',
      postId,
      authorId: authorA,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: deletedCommentId,
      content: 'hidden moderated comment',
      postId,
      authorId: authorB,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: now,
    },
    {
      id: visibleReplyId,
      content: 'visible reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleCommentId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: deletedReplyId,
      content: 'hidden moderated reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleCommentId,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
    {
      id: childOfDeletedId,
      content: 'visible reply under a hidden comment',
      postId,
      authorId: authorA,
      parentCommentId: deletedCommentId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(inArray(users.id, [authorA, authorB]));
});

describe('GET /api/comments/[id] moderation visibility', () => {
  it('does not return a soft-deleted comment at its permalink', async () => {
    const { status, body } = await fetchComment(deletedCommentId);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('hidden moderated comment');
  });

  it('omits soft-deleted replies and counts only visible comments', async () => {
    const { status, body } = await fetchComment(visibleCommentId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.comment.id).toBe(visibleCommentId);
    expect(detail.replies.map((r) => r.id)).toEqual([visibleReplyId]);
    expect(detail.comment.replyCount).toBe(1);
    // The post holds 5 comment rows, 2 of them soft-deleted.
    expect(detail.post?.commentCount).toBe(3);
  });

  it('does not leak a soft-deleted parent through the parent chain', async () => {
    const { status, body } = await fetchComment(childOfDeletedId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.parentChain.map((p) => p.id)).not.toContain(deletedCommentId);
    expect(JSON.stringify(detail.parentChain)).not.toContain(
      'hidden moderated comment'
    );
  });
});

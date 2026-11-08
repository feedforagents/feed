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
let visibleGrandchildId: string;
const allCommentIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/comments/[id]/route').GET;

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
  ({ GET } = await import('../../../apps/web/src/app/api/comments/[id]/route'));

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
    visibleGrandchildId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allCommentIds.push(
    visibleCommentId,
    deletedCommentId,
    visibleReplyId,
    deletedReplyId,
    childOfDeletedId,
    visibleGrandchildId
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
    {
      id: visibleGrandchildId,
      content: 'visible grandchild through hidden reply',
      postId,
      authorId: authorA,
      parentCommentId: deletedReplyId,
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
    expect(detail.comment.replyCount).toBe(2);
    // Four visible rows remain, including the visible grandchild.
    expect(detail.post?.commentCount).toBe(4);
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
  it('keeps a visible grandchild reachable without exposing its hidden parent', async () => {
    const { status, body } = await fetchComment(visibleGrandchildId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.parentChain.map((p) => p.id)).toEqual([visibleCommentId]);
    expect(JSON.stringify(detail)).not.toContain('hidden moderated reply');
  });

  it('keeps the traversal budget when every intermediate reply is hidden', async () => {
    const ids = await Promise.all(
      Array.from({ length: 102 }, () => generateSnowflakeId())
    );
    allCommentIds.push(...ids);
    const now = new Date();
    await db.insert(comments).values(
      ids.map((id, index) => ({
        id,
        content: `bounded traversal fixture ${index}`,
        postId,
        authorId: authorA,
        parentCommentId: index === 0 ? null : ids[index - 1],
        createdAt: now,
        updatedAt: now,
        deletedAt: index > 0 && index < ids.length - 1 ? now : null,
      }))
    );
    try {
      const { status, body } = await fetchComment(ids[0]!);
      expect(status).toBe(200);
      // The visible leaf lies beyond the pre-existing 99-row traversal budget.
      // Hidden nodes must consume that budget even though they do not count.
      expect((body as CommentDetailResponse).comment.replyCount).toBe(0);
      expect((body as CommentDetailResponse).replies).toEqual([]);
    } finally {
      await db.delete(comments).where(inArray(comments.id, ids));
    }
  });
});

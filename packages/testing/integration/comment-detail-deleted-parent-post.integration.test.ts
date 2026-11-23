/**
 * GET /api/comments/[id] against a real database: a soft-deleted parent post
 * must not leak its full body through the comment permalink.
 *
 * Restoration basis (in-repo, stated rules — no PRD permalink rule exists):
 * - Profile Replies tab (`apps/web/src/app/api/users/[userId]/posts/route.ts`):
 *   "Deleted or not-yet-published (future) parents are never exposed; the
 *   reply renders with post: null instead." — filters `isNull(posts.deletedAt)`.
 * - Post detail (`apps/web/src/app/api/posts/[id]/route.ts`): a deleted post
 *   throws POST_DELETED, so its own detail route never returns the body.
 * - This route itself 404s soft-deleted comments ("Soft-deleted (moderated)
 *   comments must never be returned") but applies no equivalent check to the
 *   parent post it loads and returns as `post.content`.
 * - The permalink moderation test header states "every sibling read path
 *   filters deletedAt".
 *
 * The request is anonymous (optionalAuth returns null without a token), so no
 * module is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

// The post detail route transitively imports `server-only` (via the like
// route's posthog server import); stub it like the other post-detail tests.
mock.module('server-only', () => ({}));

import { comments, db, eq, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type CommentDetailResponse = {
  comment: { id: string; content: string };
  replies: Array<{ id: string; content: string }>;
  parentChain: Array<{ id: string; content: string }>;
  post: { id: string; content: string } | null;
};

let authorA: string;
let postId: string;
let commentId: string;
let postContent: string;

let GET: typeof import('../../../apps/web/src/app/api/comments/[id]/route').GET;
let GET_POST: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;

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

async function fetchPost(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${id}`)
  );
  const response = await GET_POST(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/comments/[id]/route'));
  ({ GET: GET_POST } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  [authorA, postId, commentId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  postContent = `xviia deleted parent post ${postId}`;

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values({
    id: authorA,
    username: `test-cmt-xviia-${authorA}`,
    displayName: 'Comment Fixture XVII-A',
    updatedAt: now,
  });

  await db.insert(posts).values({
    id: postId,
    content: postContent,
    authorId: authorA,
    timestamp: earlier,
    createdAt: earlier,
  });

  await db.insert(comments).values({
    id: commentId,
    content: 'xviia visible comment on parent post',
    postId,
    authorId: authorA,
    parentCommentId: null,
    createdAt: earlier,
    updatedAt: earlier,
    deletedAt: null,
  });
});

afterAll(async () => {
  await db.delete(comments).where(eq(comments.id, commentId));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(eq(users.id, authorA));
});

describe('GET /api/comments/[id] deleted parent post', () => {
  it('returns the parent post while it is visible', async () => {
    const { status, body } = await fetchComment(commentId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.comment.id).toBe(commentId);
    expect(detail.post?.id).toBe(postId);
    expect(detail.post?.content).toBe(postContent);
  });

  it('does not leak a soft-deleted parent post through the permalink', async () => {
    const now = new Date();
    await db.update(posts).set({ deletedAt: now }).where(eq(posts.id, postId));

    // Contrast: the post's own detail route refuses the deleted post
    // (BusinessLogicError POST_DELETED, HTTP 400).
    const postRes = await fetchPost(postId);
    expect(postRes.status).toBe(400);
    expect(JSON.stringify(postRes.body)).toContain(
      'This post has been deleted'
    );

    // The permalink must not expose the deleted parent either: same rule as
    // the profile Replies tab — the reply renders with post: null instead.
    const { status, body } = await fetchComment(commentId);
    expect(status).toBe(200);
    const detail = body as CommentDetailResponse;
    expect(detail.comment.id).toBe(commentId);
    expect(detail.post).toBeNull();
    expect(JSON.stringify(body)).not.toContain(postContent);
  });
});

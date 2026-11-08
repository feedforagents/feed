/**
 * GET /api/posts/[id]/comments against a real database: the `total` in the
 * response must equal the number of comments the same response actually
 * returns in its tree.
 *
 * Scenario: moderation hides a parent comment (the admin content-queue
 * "hide" action sets comments.deletedAt on that one row; it does not
 * cascade). The replies under it stay non-deleted, but the route's own tree
 * rule omits them — "Comments whose parent is not visible (e.g. hidden by
 * moderation) are unreachable from the root and therefore omitted with
 * their parent." The base route still counts those unreachable replies in
 * `total` (it uses the raw row count), so the response promises comments
 * that are not in the list. Sibling counts already follow the
 * count-only-what-is-visible rule (#1658 following-feed comment counts).
 *
 * Several comments share one createdAt timestamp to cover the
 * equal-timestamp axis: with no cursor/page parameters on this route,
 * every reachable comment must be delivered in the single response.
 *
 * The real route and database are used. Only the server-only environment
 * marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, eq, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type CommentNode = {
  id: string;
  replies: CommentNode[];
};

type CommentsResponse = {
  success: boolean;
  data: { comments: CommentNode[]; total: number };
};

let authorId: string;
let commenterId: string;
let postId: string;
let parentCommentId: string;
const allCommentIds: string[] = [];

let GET: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/[id]/comments/route';

function flattenIds(nodes: CommentNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...flattenIds(node.replies)]);
}

async function fetchComments() {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/comments`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  [authorId, commenterId, postId, parentCommentId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const [orphanReplyId, visibleTopId, visibleReplyId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allCommentIds.push(
    parentCommentId,
    orphanReplyId,
    visibleTopId,
    visibleReplyId
  );

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  // One shared timestamp for the parent, its reply, and the visible
  // top-level comment (equal-timestamp axis).
  const sharedTs = new Date(now.getTime() - 30_000);

  await db.insert(users).values([
    {
      id: authorId,
      username: `g18a-${authorId}`,
      displayName: 'Comment List Author',
      updatedAt: now,
    },
    {
      id: commenterId,
      username: `g18c-${commenterId}`,
      displayName: 'Comment List Commenter',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values({
    id: postId,
    content: 'fixture post for comment list total',
    authorId,
    timestamp: earlier,
    createdAt: earlier,
  });

  await db.insert(comments).values([
    {
      id: parentCommentId,
      content: 'parent comment that moderation will hide',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: sharedTs,
      updatedAt: sharedTs,
      deletedAt: null,
    },
    {
      id: orphanReplyId,
      content: 'reply under the soon-to-be-hidden parent',
      postId,
      authorId: authorId,
      parentCommentId,
      createdAt: sharedTs,
      updatedAt: sharedTs,
      deletedAt: null,
    },
    {
      id: visibleTopId,
      content: 'visible top-level comment',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: sharedTs,
      updatedAt: sharedTs,
      deletedAt: null,
    },
    {
      id: visibleReplyId,
      content: 'visible reply',
      postId,
      authorId: authorId,
      parentCommentId: visibleTopId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(inArray(users.id, [authorId, commenterId]));
});

describe('GET /api/posts/[id]/comments total', () => {
  it('total equals the number of comments delivered in the tree', async () => {
    const { status, body } = await fetchComments();
    expect(status).toBe(200);
    const data = (body as CommentsResponse).data;
    const delivered = flattenIds(data.comments);
    // All four comments are reachable, including the three that share one
    // createdAt timestamp.
    expect(delivered).toHaveLength(4);
    expect(data.total).toBe(4);
    expect(data.total).toBe(delivered.length);
  });

  it('does not count replies whose parent was hidden by moderation', async () => {
    // The admin content-queue "hide" action: soft-delete the one row.
    await db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(eq(comments.id, parentCommentId));

    const { status, body } = await fetchComments();
    expect(status).toBe(200);
    const data = (body as CommentsResponse).data;
    const delivered = flattenIds(data.comments);
    // The hidden parent and its (non-deleted) reply are both absent from
    // the tree; only the visible top-level comment and its reply remain.
    expect(delivered).toHaveLength(2);
    expect(delivered).not.toContain(parentCommentId);
    expect(data.total).toBe(delivered.length);
  });
});

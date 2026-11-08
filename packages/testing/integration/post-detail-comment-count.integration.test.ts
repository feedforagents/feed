/**
 * GET /api/posts/[id] against a real database: the `commentCount` in the
 * response is the number shown at the top of the post detail screen, and it
 * must equal the number of comments the comment list for the same post
 * actually delivers.
 *
 * Scenario: moderation hides a parent comment (the admin content-queue
 * "hide" action sets comments.deletedAt on that one row; it does not
 * cascade). The replies under it — including a nested grandchild — stay
 * non-deleted, but the comment list's tree rule omits the whole subtree:
 * "Comments whose parent is not visible (e.g. hidden by moderation) are
 * unreachable from the root and therefore omitted with their parent." The
 * base detail route counts every non-deleted row, so the header promises
 * comments that are not in the list below it. Sibling counts already follow
 * the count-only-what-is-visible rule (#1658 following-feed comment counts,
 * and the comment list's own total).
 *
 * A reply that is itself soft-deleted is included as a control: both routes
 * already exclude it, before and after.
 *
 * Several comments share one createdAt timestamp to cover the
 * equal-timestamp axis.
 *
 * The real routes and database are used. Only the server-only environment
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

type PostResponse = {
  success: boolean;
  data: { id: string; commentCount: number };
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

let getPost: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let getComments: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const postRoutePath = '../../../apps/web/src/app/api/posts/[id]/route';
const commentsRoutePath =
  '../../../apps/web/src/app/api/posts/[id]/comments/route';

function flattenIds(nodes: CommentNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...flattenIds(node.replies)]);
}

async function fetchPostCommentCount() {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}`)
  );
  const response = await getPost(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchDeliveredCommentIds() {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/comments`)
  );
  const response = await getComments(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET: getPost } = await import(postRoutePath));
  ({ GET: getComments } = await import(commentsRoutePath));

  [authorId, commenterId, postId, parentCommentId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const [childId, grandchildId, visibleTopId, visibleReplyId, deletedReplyId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  allCommentIds.push(
    parentCommentId,
    childId,
    grandchildId,
    visibleTopId,
    visibleReplyId,
    deletedReplyId
  );

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  // One shared timestamp for the parent, its subtree, and the visible
  // top-level comment (equal-timestamp axis).
  const sharedTs = new Date(now.getTime() - 30_000);

  await db.insert(users).values([
    {
      id: authorId,
      username: `g22a-${authorId}`,
      displayName: 'Post Detail Author',
      updatedAt: now,
    },
    {
      id: commenterId,
      username: `g22c-${commenterId}`,
      displayName: 'Post Detail Commenter',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values({
    id: postId,
    content: 'fixture post for post detail comment count',
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
      id: childId,
      content: 'reply under the soon-to-be-hidden parent',
      postId,
      authorId: authorId,
      parentCommentId,
      createdAt: sharedTs,
      updatedAt: sharedTs,
      deletedAt: null,
    },
    {
      id: grandchildId,
      content: 'nested reply under the hidden parent subtree',
      postId,
      authorId: commenterId,
      parentCommentId: childId,
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
    {
      id: deletedReplyId,
      content: 'reply that is itself soft-deleted (control)',
      postId,
      authorId: authorId,
      parentCommentId: visibleTopId,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(eq(posts.id, postId));
  await db.delete(users).where(inArray(users.id, [authorId, commenterId]));
});

describe('GET /api/posts/[id] commentCount', () => {
  it('commentCount equals the number of comments the list delivers', async () => {
    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    // Five comments are reachable; the soft-deleted reply is excluded by
    // both routes already.
    expect(delivered).toHaveLength(5);

    const { status, body } = await fetchPostCommentCount();
    expect(status).toBe(200);
    expect((body as PostResponse).data.commentCount).toBe(delivered.length);
  });

  it('does not count replies whose parent was hidden by moderation', async () => {
    // The admin content-queue "hide" action: soft-delete the one row.
    await db
      .update(comments)
      .set({ deletedAt: new Date() })
      .where(eq(comments.id, parentCommentId));

    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    // The hidden parent and its whole (non-deleted) subtree are absent from
    // the tree; only the visible top-level comment and its reply remain.
    expect(delivered).toHaveLength(2);
    expect(delivered).not.toContain(parentCommentId);

    const { status, body } = await fetchPostCommentCount();
    expect(status).toBe(200);
    // The header count must promise only what the list below it shows.
    expect((body as PostResponse).data.commentCount).toBe(2);
    expect((body as PostResponse).data.commentCount).toBe(delivered.length);
  });
});

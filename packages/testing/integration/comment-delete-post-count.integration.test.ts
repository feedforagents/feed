/**
 * PRD §§6.1/12 and MVP Phase 5 preserve public posts and moderation.
 * The `commentCount` shown at the top of the post detail screen must equal
 * the number of comments the comment list for the same post actually
 * delivers (see post-detail-comment-count.integration.test.ts).
 *
 * This test pins the server side of that contract for the delete flow,
 * through the real handlers: deleting a top-level comment removes the
 * comment and its replies, DELETE /api/comments/[id] reports how many
 * replies went with it (`deletedRepliesCount`), and GET /api/posts/[id]
 * drops by the comment plus its replies. The detail-page store reads that
 * field to keep the displayed count in step without a reload (see the
 * deleteComment tests in unit/interaction-store.test.ts); this test proves
 * the number it reads is real and matches the server count drop.
 *
 * The real routes and database are used. Only the server-only environment
 * marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type PostResponse = {
  success: boolean;
  data: { id: string; commentCount: number };
};

type DeleteResponse = {
  message: string;
  deletedCommentId: string;
  deletedRepliesCount: number;
};

type CommentNode = {
  id: string;
  replies: CommentNode[];
};

type CommentsResponse = {
  success: boolean;
  data: { comments: CommentNode[]; total: number };
};

function ownership() {
  return {
    users: new Set<string>(),
    posts: new Set<string>(),
    comments: new Set<string>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

let authorId: string;
let commenterId: string;
let postId: string;
let topCommentId: string;
let replyOneId: string;
let replyTwoId: string;
let otherTopCommentId: string;

let getPost: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let getComments: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let deleteComment: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const postRoutePath = '../../../apps/web/src/app/api/posts/[id]/route';
const commentsRoutePath =
  '../../../apps/web/src/app/api/posts/[id]/comments/route';
const deleteRoutePath = '../../../apps/web/src/app/api/comments/[id]/route';

function flattenIds(nodes: CommentNode[]): string[] {
  return nodes.flatMap((node) => [node.id, ...flattenIds(node.replies)]);
}

async function fetchPostCommentCount(targetPostId: string = postId) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}`)
  );
  const response = await getPost(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchDeliveredCommentIds(targetPostId: string = postId) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetPostId}/comments`)
  );
  const response = await getComments(request, {
    params: Promise.resolve({ id: targetPostId }),
  });
  const body = (await response.json().catch(() => null)) as
    | CommentsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function deleteAsCommenter(targetCommentId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/comments/${targetCommentId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer steward:test:${commenterId}` },
    })
  );
  const response = await deleteComment(request, {
    params: Promise.resolve({ id: targetCommentId }),
  });
  const body = (await response.json().catch(() => null)) as
    | DeleteResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function cleanup(receipts: Ownership) {
  const actions = [
    {
      ids: receipts.comments,
      remove: () =>
        db
          .delete(comments)
          .where(inArray(comments.id, [...receipts.comments]))
          .returning({ id: comments.id }),
    },
    {
      ids: receipts.posts,
      remove: () =>
        db
          .delete(posts)
          .where(inArray(posts.id, [...receipts.posts]))
          .returning({ id: posts.id }),
    },
    {
      ids: receipts.users,
      remove: () =>
        db
          .delete(users)
          .where(inArray(users.id, [...receipts.users]))
          .returning({ id: users.id }),
    },
  ];
  const failures: Error[] = [];
  for (const { ids, remove } of actions) {
    if (ids.size === 0) continue;
    try {
      for (const row of await remove()) ids.delete(row.id);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (Object.values(receipts).some((ids) => ids.size > 0))
    failures.push(
      new Error('Owned comment-delete identities remain after cleanup')
    );
  if (failures.length)
    throw new AggregateError(failures, 'Owned comment-delete cleanup failed');
}

beforeAll(async () => {
  ({ GET: getPost } = await import(postRoutePath));
  ({ GET: getComments } = await import(commentsRoutePath));
  ({ DELETE: deleteComment } = await import(deleteRoutePath));

  [authorId, commenterId, postId, topCommentId, otherTopCommentId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const [replyOne, replyTwo] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  replyOneId = replyOne;
  replyTwoId = replyTwo;

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `ic-del-a-${authorId}`,
        displayName: 'Comment Delete Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `ic-del-c-${commenterId}`,
        displayName: 'Comment Delete Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedPost = await db
    .insert(posts)
    .values({
      id: postId,
      content: 'fixture post for comment delete post count',
      authorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of insertedPost) owned.posts.add(row.id);

  const insertedComments = await db
    .insert(comments)
    .values([
      {
        id: topCommentId,
        content: 'top-level comment with two replies',
        postId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: replyOneId,
        content: 'first reply under the deleted comment',
        postId,
        authorId,
        parentCommentId: topCommentId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: replyTwoId,
        content: 'second reply under the deleted comment',
        postId,
        authorId: commenterId,
        parentCommentId: topCommentId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: otherTopCommentId,
        content: 'unrelated top-level comment that survives',
        postId,
        authorId: commenterId,
        parentCommentId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);
});

afterAll(async () => cleanup(owned));

describe('DELETE /api/comments/[id] post comment count', () => {
  it('reports the deleted replies and drops the detail count by comment plus replies', async () => {
    const before = await fetchPostCommentCount();
    expect(before.status).toBe(200);
    expect((before.body as PostResponse).data.commentCount).toBe(4);

    const deleted = await deleteAsCommenter(topCommentId);
    expect(deleted.status).toBe(200);
    expect((deleted.body as DeleteResponse).deletedCommentId).toBe(
      topCommentId
    );
    expect((deleted.body as DeleteResponse).deletedRepliesCount).toBe(2);
    // The handler hard-deleted these rows, so they are no longer owned
    // for cleanup.
    owned.comments.delete(topCommentId);
    owned.comments.delete(replyOneId);
    owned.comments.delete(replyTwoId);

    const after = await fetchPostCommentCount();
    expect(after.status).toBe(200);
    // The comment and both of its replies are gone: 4 -> 1.
    expect((after.body as PostResponse).data.commentCount).toBe(1);

    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    expect(delivered).toEqual([otherTopCommentId]);
    expect((list.body as CommentsResponse).data.total).toBe(1);
    expect((after.body as PostResponse).data.commentCount).toBe(
      delivered.length
    );
  });
});

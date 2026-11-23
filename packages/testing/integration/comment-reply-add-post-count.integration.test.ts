/**
 * PRD §§6.1/12 and MVP Phase 5 preserve public posts and moderation.
 * The `commentCount` shown at the top of the post detail screen must equal
 * the number of comments the comment list for the same post actually
 * delivers (see post-detail-comment-count.integration.test.ts).
 *
 * This test pins the server side of that contract for the reply-add flow,
 * through the real handlers: posting a reply under a top-level comment
 * raises GET /api/posts/[id] by one, and the comment list delivers one
 * more comment. The detail-page store reads the server count only on a
 * full load, so the store must bump its own displayed count when a reply
 * succeeds (see the addComment tests in unit/interaction-store.test.ts);
 * this test proves the number it should reach is real and matches the
 * server count after the reply.
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

type PostCommentResponse = {
  id: string;
  content: string;
  postId: string;
  authorId: string;
  parentCommentId: string | null;
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

let getPost: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let getComments: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let postComment: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
const postRoutePath = '../../../apps/web/src/app/api/posts/[id]/route';
const commentsRoutePath =
  '../../../apps/web/src/app/api/posts/[id]/comments/route';

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

async function postReplyAsCommenter(parentCommentId: string, content: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer steward:test:${commenterId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content, parentCommentId }),
    })
  );
  const response = await postComment(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostCommentResponse
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
      new Error('Owned comment-reply identities remain after cleanup')
    );
  if (failures.length)
    throw new AggregateError(failures, 'Owned comment-reply cleanup failed');
}

beforeAll(async () => {
  ({ GET: getPost } = await import(postRoutePath));
  ({ GET: getComments, POST: postComment } = await import(commentsRoutePath));

  [authorId, commenterId, postId, topCommentId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: authorId,
        username: `iib-rep-a-${authorId}`,
        displayName: 'Comment Reply Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `iib-rep-c-${commenterId}`,
        displayName: 'Comment Reply Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedPost = await db
    .insert(posts)
    .values({
      id: postId,
      content: 'fixture post for comment reply add post count',
      authorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of insertedPost) owned.posts.add(row.id);

  const insertedComments = await db
    .insert(comments)
    .values({
      id: topCommentId,
      content: 'top-level comment that receives a reply',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    })
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);
});

afterAll(async () => cleanup(owned));

describe('POST /api/posts/[id]/comments reply post comment count', () => {
  it('raises the detail count by one and delivers one more comment', async () => {
    const before = await fetchPostCommentCount();
    expect(before.status).toBe(200);
    expect((before.body as PostResponse).data.commentCount).toBe(1);

    const created = await postReplyAsCommenter(
      topCommentId,
      'a reply under the top-level comment'
    );
    expect(created.status).toBe(201);
    const reply = created.body as PostCommentResponse;
    expect(reply.parentCommentId).toBe(topCommentId);
    owned.comments.add(reply.id);

    const after = await fetchPostCommentCount();
    expect(after.status).toBe(200);
    // The reply is a comment on this post too: 1 -> 2.
    expect((after.body as PostResponse).data.commentCount).toBe(2);

    const list = await fetchDeliveredCommentIds();
    expect(list.status).toBe(200);
    const delivered = flattenIds((list.body as CommentsResponse).data.comments);
    expect(delivered).toEqual([topCommentId, reply.id]);
    expect((list.body as CommentsResponse).data.total).toBe(2);
    expect((after.body as PostResponse).data.commentCount).toBe(
      delivered.length
    );
  });
});

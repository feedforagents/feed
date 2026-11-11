/**
 * Web DELETE /api/comments/[id] against a real database.
 *
 * The route's own contract says "Deletes comment and all replies" and
 * "Includes cascade deletion of replies and reactions", and its response
 * reports `deletedRepliesCount`. The scenario builds a three-level thread
 * (comment -> reply -> grandchild -> great-grandchild) with a like on
 * every level, plus an unrelated control thread on the same post.
 *
 * On the base route only the direct replies are removed: the grandchild
 * and great-grandchild rows survive with parentCommentId pointing at a
 * physically deleted comment, their likes survive with them, the MCP
 * get_comments flat list keeps returning their content for the post, the
 * web comment detail route keeps serving them by id, and new replies can
 * still be posted under them — while the web comment list and the post
 * detail count (tree-reachability rule, see
 * post-detail-comment-count.integration.test.ts) no longer show them.
 *
 * A non-author delete attempt is included as an ownership control: it is
 * rejected before and after.
 *
 * The real routes, the real MCP handler, and the real database are used.
 * Only the server-only environment marker is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, inArray, posts, reactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { executeGetComments } from '../../mcp/src/handlers/tool-handlers';
import type { AuthenticatedAgent } from '../../mcp/src/types/mcp';

type DeleteResponse = {
  message: string;
  deletedCommentId: string;
  deletedRepliesCount: number;
};

const owned = {
  users: new Set<string>(),
  posts: new Set<string>(),
  comments: new Set<string>(),
  reactions: new Set<string>(),
};

let postAuthorId: string;
let threadAuthorId: string;
let replierId: string;
let secondReplierId: string;
let postId: string;
let parentId: string;
let replyId: string;
let grandchildId: string;
let greatGrandchildId: string;
let controlTopId: string;
let controlReplyId: string;

let deleteComment: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let getCommentDetail: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;
let createComment: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

const commentRoutePath = '../../../apps/web/src/app/api/comments/[id]/route';
const commentsRoutePath =
  '../../../apps/web/src/app/api/posts/[id]/comments/route';

function authHeaders(userId: string) {
  return { authorization: `Bearer steward:test:${userId}` };
}

async function callDelete(commentId: string, asUserId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/comments/${commentId}`, {
      method: 'DELETE',
      headers: authHeaders(asUserId),
    })
  );
  const response = await deleteComment(request, {
    params: Promise.resolve({ id: commentId }),
  });
  const body = (await response.json().catch(() => null)) as
    | DeleteResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function rowsByIds(table: 'comments' | 'reactions', ids: string[]) {
  if (table === 'comments') {
    return db
      .select({ id: comments.id })
      .from(comments)
      .where(inArray(comments.id, ids));
  }
  return db
    .select({ id: reactions.id })
    .from(reactions)
    .where(inArray(reactions.commentId, ids));
}

async function cleanup() {
  if (owned.reactions.size > 0) {
    await db
      .delete(reactions)
      .where(inArray(reactions.id, [...owned.reactions]));
  }
  if (owned.comments.size > 0) {
    await db.delete(comments).where(inArray(comments.id, [...owned.comments]));
  }
  if (owned.posts.size > 0) {
    await db.delete(posts).where(inArray(posts.id, [...owned.posts]));
  }
  if (owned.users.size > 0) {
    await db.delete(users).where(inArray(users.id, [...owned.users]));
  }
}

beforeAll(async () => {
  ({ DELETE: deleteComment, GET: getCommentDetail } = await import(
    commentRoutePath
  ));
  ({ POST: createComment } = await import(commentsRoutePath));

  [
    postAuthorId,
    threadAuthorId,
    replierId,
    secondReplierId,
    postId,
    parentId,
    replyId,
    grandchildId,
    greatGrandchildId,
    controlTopId,
    controlReplyId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
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
        id: postAuthorId,
        username: `f194-pa-${postAuthorId}`,
        displayName: 'Cascade Post Author',
        isTest: true,
        updatedAt: now,
      },
      {
        id: threadAuthorId,
        username: `f194-ta-${threadAuthorId}`,
        displayName: 'Cascade Thread Author',
        isTest: true,
        updatedAt: now,
      },
      {
        id: replierId,
        username: `f194-r1-${replierId}`,
        displayName: 'Cascade Replier',
        isTest: true,
        updatedAt: now,
      },
      {
        id: secondReplierId,
        username: `f194-r2-${secondReplierId}`,
        displayName: 'Cascade Second Replier',
        isTest: true,
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) owned.users.add(row.id);

  const insertedPost = await db
    .insert(posts)
    .values({
      id: postId,
      content: 'fixture post for comment delete cascade',
      authorId: postAuthorId,
      timestamp: earlier,
      createdAt: earlier,
    })
    .returning({ id: posts.id });
  for (const row of insertedPost) owned.posts.add(row.id);

  const insertedComments = await db
    .insert(comments)
    .values([
      {
        id: parentId,
        content: 'top-level comment that will be deleted',
        postId,
        authorId: threadAuthorId,
        parentCommentId: null,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: replyId,
        content: 'direct reply to the deleted comment',
        postId,
        authorId: replierId,
        parentCommentId: parentId,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: grandchildId,
        content: 'grandchild reply two levels down',
        postId,
        authorId: secondReplierId,
        parentCommentId: replyId,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: greatGrandchildId,
        content: 'great-grandchild reply three levels down',
        postId,
        authorId: replierId,
        parentCommentId: grandchildId,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: controlTopId,
        content: 'unrelated top-level comment (control)',
        postId,
        authorId: replierId,
        parentCommentId: null,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
      {
        id: controlReplyId,
        content: 'reply under the control comment',
        postId,
        authorId: secondReplierId,
        parentCommentId: controlTopId,
        createdAt: earlier,
        updatedAt: earlier,
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedComments) owned.comments.add(row.id);

  const [
    likeParentId,
    likeReplyId,
    likeGrandchildId,
    likeGreatId,
    likeControlId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const insertedReactions = await db
    .insert(reactions)
    .values([
      // One like on every level of the thread being deleted.
      {
        id: likeParentId,
        postId: null,
        commentId: parentId,
        userId: postAuthorId,
        type: 'like',
      },
      {
        id: likeReplyId,
        postId: null,
        commentId: replyId,
        userId: secondReplierId,
        type: 'like',
      },
      {
        id: likeGrandchildId,
        postId: null,
        commentId: grandchildId,
        userId: threadAuthorId,
        type: 'like',
      },
      {
        id: likeGreatId,
        postId: null,
        commentId: greatGrandchildId,
        userId: postAuthorId,
        type: 'like',
      },
      // Control like on the unrelated thread.
      {
        id: likeControlId,
        postId: null,
        commentId: controlTopId,
        userId: postAuthorId,
        type: 'like',
      },
    ])
    .returning({ id: reactions.id });
  for (const row of insertedReactions) owned.reactions.add(row.id);
});

afterAll(cleanup);

describe('DELETE /api/comments/[id] cascade', () => {
  it('rejects a delete attempt by a non-author (ownership control)', async () => {
    const { status } = await callDelete(controlTopId, secondReplierId);
    expect(status).toBe(403);
    const surviving = await rowsByIds('comments', [controlTopId]);
    expect(surviving).toHaveLength(1);
  });

  it('removes the whole subtree and its reactions, and reports all of them', async () => {
    const { status, body } = await callDelete(parentId, threadAuthorId);
    expect(status).toBe(200);
    // The route promises "all replies": three descendants exist below the
    // deleted comment (reply, grandchild, great-grandchild).
    expect((body as DeleteResponse).deletedRepliesCount).toBe(3);

    const threadIds = [parentId, replyId, grandchildId, greatGrandchildId];
    const survivingComments = await rowsByIds('comments', threadIds);
    expect(survivingComments).toHaveLength(0);
    const survivingReactions = await rowsByIds('reactions', threadIds);
    expect(survivingReactions).toHaveLength(0);

    // The unrelated control thread and its like are untouched.
    const controlComments = await rowsByIds('comments', [
      controlTopId,
      controlReplyId,
    ]);
    expect(controlComments).toHaveLength(2);
    const controlReactions = await rowsByIds('reactions', [controlTopId]);
    expect(controlReactions).toHaveLength(1);
  });

  it('leaves nothing of the deleted thread reachable on read paths', async () => {
    // MCP get_comments is a flat list of the post's non-deleted comments:
    // no part of the deleted thread may be returned.
    const agent = { userId: postAuthorId } as AuthenticatedAgent;
    const result = await executeGetComments(agent, { postId, limit: 50 });
    const returnedIds = result.comments.map((c) => c.id);
    expect(returnedIds).not.toContain(grandchildId);
    expect(returnedIds).not.toContain(greatGrandchildId);
    expect(returnedIds).toContain(controlTopId);

    // The web comment detail route must not serve a deleted descendant.
    const detailRequest = new NextRequest(
      new Request(`http://localhost/api/comments/${grandchildId}`)
    );
    const detailResponse = await getCommentDetail(detailRequest, {
      params: Promise.resolve({ id: grandchildId }),
    });
    expect(detailResponse.status).toBe(404);
  });

  it('does not accept new replies under a deleted descendant', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          ...authHeaders(replierId),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          content: `f194 reply under a deleted thread ${greatGrandchildId}`,
          parentCommentId: greatGrandchildId,
        }),
      })
    );
    const response = await createComment(request, {
      params: Promise.resolve({ id: postId }),
    });
    expect(response.status).toBe(404);
  });
});

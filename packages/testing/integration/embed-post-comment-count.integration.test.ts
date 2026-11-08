/**
 * GET /api/embed/post/[id] against a real database: the commentCount in the
 * embed metadata is what a shared link preview shows, so it must count the
 * comments a visitor can actually see in the post's comment thread.
 *
 * The comment list (GET /api/posts/[id]/comments) builds a tree and omits
 * comments whose parent is not visible — a parent soft-deleted by the admin
 * content queue "hide" action takes its whole subtree out of the thread,
 * even though the replies themselves are not deleted. The embed route is
 * exercised unmodified and anonymously.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type EmbedResponse = {
  metadata: { likeCount: number; commentCount: number; shareCount: number };
};

type CommentTreeItem = { id: string; replies: CommentTreeItem[] };
type CommentListResponse = { data: { comments: CommentTreeItem[] } };

let authorA: string;
let authorB: string;
let postId: string;
let controlPostId: string;
const allPostIds: string[] = [];
const allCommentIds: string[] = [];

let embedGET: typeof import('../../../apps/web/src/app/api/embed/post/[id]/route').GET;
let listGET: typeof import('../../../apps/web/src/app/api/posts/[id]/comments/route').GET;

async function fetchEmbedCommentCount(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/embed/post/${id}`)
  );
  const response = await embedGET(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response
    .json()
    .catch(() => null)) as EmbedResponse | null;
  return { status: response.status, commentCount: body?.metadata.commentCount };
}

function countTreeNodes(items: CommentTreeItem[]): number {
  let total = 0;
  for (const item of items) {
    total += 1 + countTreeNodes(item.replies);
  }
  return total;
}

async function fetchVisibleCommentCount(id: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${id}/comments`)
  );
  const response = await listGET(request, {
    params: Promise.resolve({ id }),
  });
  const body = (await response
    .json()
    .catch(() => null)) as CommentListResponse | null;
  return {
    status: response.status,
    visible: body ? countTreeNodes(body.data.comments) : -1,
  };
}

beforeAll(async () => {
  ({ GET: embedGET } = await import(
    '../../../apps/web/src/app/api/embed/post/[id]/route'
  ));
  ({ GET: listGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  ));

  [authorA, authorB, postId, controlPostId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  allPostIds.push(postId, controlPostId);

  const ids = await Promise.all(
    Array.from({ length: 9 }, () => generateSnowflakeId())
  );
  const [
    visibleRootId,
    visibleReplyId,
    hiddenRootId,
    orphanReplyId,
    orphanGrandchildId,
    deletedReplyId,
    controlRootId,
    controlReplyId,
    controlSecondRootId,
  ] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  allCommentIds.push(...ids);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: authorA,
      username: `test-embed-a-${authorA}`,
      displayName: 'Embed Fixture A',
      updatedAt: now,
    },
    {
      id: authorB,
      username: `test-embed-b-${authorB}`,
      displayName: 'Embed Fixture B',
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values([
    {
      id: postId,
      content: 'embed fixture post',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: controlPostId,
      content: 'embed control post',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  // Main post: a visible root with a visible reply; a moderation-hidden
  // root (soft-deleted only on its own row, exactly what the admin content
  // queue hide action does) whose non-deleted reply and grandchild can
  // never be reached in the thread; one directly deleted reply.
  // Visible in the thread: 2. Non-deleted rows: 4.
  await db.insert(comments).values([
    {
      id: visibleRootId,
      content: 'visible root',
      postId,
      authorId: authorA,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleReplyId,
      content: 'visible reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: hiddenRootId,
      content: 'hidden root',
      postId,
      authorId: authorB,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: now,
    },
    {
      id: orphanReplyId,
      content: 'reply under hidden root',
      postId,
      authorId: authorA,
      parentCommentId: hiddenRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: orphanGrandchildId,
      content: 'grandchild under hidden root',
      postId,
      authorId: authorA,
      parentCommentId: orphanReplyId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: deletedReplyId,
      content: 'directly deleted reply',
      postId,
      authorId: authorB,
      parentCommentId: visibleRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
    // Control post: three fully visible comments.
    {
      id: controlRootId,
      content: 'control root',
      postId: controlPostId,
      authorId: authorA,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: controlReplyId,
      content: 'control reply',
      postId: controlPostId,
      authorId: authorB,
      parentCommentId: controlRootId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: controlSecondRootId,
      content: 'control second root',
      postId: controlPostId,
      authorId: authorB,
      parentCommentId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);
});

afterAll(async () => {
  await db.delete(comments).where(inArray(comments.id, allCommentIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(inArray(users.id, [authorA, authorB]));
});

describe('GET /api/embed/post/[id] commentCount', () => {
  it('counts only the comments the comment thread can show', async () => {
    const { visible } = await fetchVisibleCommentCount(postId);
    expect(visible).toBe(2);

    const { status, commentCount } = await fetchEmbedCommentCount(postId);
    expect(status).toBe(200);
    expect(commentCount).toBe(visible);
  });

  it('still counts every visible comment on an unmoderated post', async () => {
    const { visible } = await fetchVisibleCommentCount(controlPostId);
    expect(visible).toBe(3);

    const { status, commentCount } =
      await fetchEmbedCommentCount(controlPostId);
    expect(status).toBe(200);
    expect(commentCount).toBe(3);
  });
});

/**
 * GET /api/users/[userId]/posts?type=posts against a real database: the
 * comment count shown for a simple repost must exclude soft-deleted
 * comments, exactly like the count shown for the author's own posts.
 *
 * PRD §12 keeps profiles and posts in scope. Every other comment-count
 * query in this route filters `deletedAt IS NULL` (the author's own posts,
 * and the parent-post counts in the replies branch), and merged PR #1658
 * applied the same rule to the Following feed ("exclude soft-deleted
 * comments from comment counts"). The one exception is the query that
 * counts comments on the ORIGINAL post of a repost: it has no deleted
 * filter, and for a simple repost those counts replace the repost's own
 * in the response — so a repost displays a comment count inflated by
 * comments nobody can see.
 *
 * The route is public, so the requests are anonymous. The only stub is the
 * `server-only` marker package (an empty environment guard that throws
 * outside a Server Component); every database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type PostsResponse = {
  type: 'posts';
  total: number;
  items: Array<{
    id: string;
    commentCount: number;
    originalPostId?: string | null;
  }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

let profileAuthorId: string;
let originalAuthorId: string;
let originalPostId: string;
let repostId: string;
let ownPostId: string;
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];

async function fetchPosts(userId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/posts?type=posts`)
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId }),
  });
  const raw = (await response.json().catch(() => null)) as
    | { data?: PostsResponse }
    | PostsResponse
    | null;
  const body = (
    raw && 'data' in raw && raw.data ? raw.data : raw
  ) as PostsResponse | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  ));

  profileAuthorId = await generateSnowflakeId();
  originalAuthorId = await generateSnowflakeId();
  ownedUserIds.push(profileAuthorId, originalAuthorId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: profileAuthorId,
      username: `g16profile-${profileAuthorId}`,
      displayName: 'G16 Profile Author',
      updatedAt: now,
    },
    {
      id: originalAuthorId,
      username: `g16orig-${originalAuthorId}`,
      displayName: 'G16 Original Author',
      updatedAt: now,
    },
  ]);

  const t = now.getTime();
  originalPostId = await generateSnowflakeId();
  repostId = await generateSnowflakeId();
  ownPostId = await generateSnowflakeId();
  const deletedOwnPostId = await generateSnowflakeId();
  const futureOwnPostId = await generateSnowflakeId();
  ownedPostIds.push(
    originalPostId,
    repostId,
    ownPostId,
    deletedOwnPostId,
    futureOwnPostId
  );
  await db.insert(posts).values([
    {
      id: originalPostId,
      content: 'original post that gets reposted',
      authorId: originalAuthorId,
      timestamp: new Date(t - 120 * 60_000),
      createdAt: new Date(t - 120 * 60_000),
    },
    {
      // Simple repost (no commentary) of the original post.
      id: repostId,
      content: '',
      authorId: profileAuthorId,
      originalPostId,
      timestamp: new Date(t - 60 * 60_000),
      createdAt: new Date(t - 60 * 60_000),
    },
    {
      id: ownPostId,
      content: 'profile author own post',
      authorId: profileAuthorId,
      timestamp: new Date(t - 30 * 60_000),
      createdAt: new Date(t - 30 * 60_000),
    },
    {
      id: deletedOwnPostId,
      content: 'soft-deleted own post',
      authorId: profileAuthorId,
      timestamp: new Date(t - 20 * 60_000),
      createdAt: new Date(t - 20 * 60_000),
      deletedAt: new Date(t - 10 * 60_000),
    },
    {
      id: futureOwnPostId,
      content: 'future own post',
      authorId: profileAuthorId,
      timestamp: new Date(t + 24 * 60 * 60_000),
      createdAt: new Date(t),
    },
  ]);

  const commentRows: Array<typeof comments.$inferInsert> = [];
  async function addComment(
    postId: string,
    content: string,
    minutesAgo: number,
    deleted = false
  ) {
    const id = await generateSnowflakeId();
    ownedCommentIds.push(id);
    commentRows.push({
      id,
      content,
      postId,
      authorId: originalAuthorId,
      createdAt: new Date(t - minutesAgo * 60_000),
      updatedAt: new Date(t - minutesAgo * 60_000),
      ...(deleted ? { deletedAt: new Date(t - minutesAgo * 60_000) } : {}),
    });
  }
  // Original post: 3 visible comments, 2 soft-deleted comments.
  await addComment(originalPostId, 'visible comment 1', 110);
  await addComment(originalPostId, 'visible comment 2', 109);
  await addComment(originalPostId, 'visible comment 3', 108);
  await addComment(originalPostId, 'deleted comment 1', 107, true);
  await addComment(originalPostId, 'deleted comment 2', 106, true);
  // Own post: 2 visible comments, 1 soft-deleted comment.
  await addComment(ownPostId, 'own visible comment 1', 25);
  await addComment(ownPostId, 'own visible comment 2', 24);
  await addComment(ownPostId, 'own deleted comment', 23, true);
  await db.insert(comments).values(commentRows);
});

afterAll(async () => {
  if (ownedCommentIds.length)
    await db.delete(comments).where(inArray(comments.id, ownedCommentIds));
  if (ownedPostIds.length)
    await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  if (ownedUserIds.length)
    await db.delete(users).where(inArray(users.id, ownedUserIds));
});

describe('profile posts list — repost comment counts', () => {
  it('counts only visible comments for a simple repost of another post', async () => {
    const { status, body } = await fetchPosts(profileAuthorId);
    expect(status).toBe(200);
    const repost = body!.items.find((item) => item.id === repostId);
    expect(repost).toBeDefined();
    expect(repost!.commentCount).toBe(3);
  });

  it('counts only visible comments for the author own post (control)', async () => {
    const { status, body } = await fetchPosts(profileAuthorId);
    expect(status).toBe(200);
    const own = body!.items.find((item) => item.id === ownPostId);
    expect(own).toBeDefined();
    expect(own!.commentCount).toBe(2);
  });

  it('lists only the visible posts (deleted and future posts excluded)', async () => {
    const { status, body } = await fetchPosts(profileAuthorId);
    expect(status).toBe(200);
    expect(body!.items.map((item) => item.id).sort()).toEqual(
      [ownPostId, repostId].sort()
    );
    expect(body!.total).toBe(2);
  });
});

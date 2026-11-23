/**
 * GET /api/feed/for-you against a real database: the comment count shown
 * on a For You card must count only comments the post detail screen can
 * actually show. A reply under a soft-deleted parent is unreachable —
 * GET /api/posts/[id] counts it out via the reachable comment tree
 * (countReachablePostComments) — but the For You pipeline counts every
 * non-deleted row, so the card promises a comment that does not exist
 * when the user opens the post. This is the same #1994 rule
 * #2100 applied to GET /api/posts: the card must promise only what the
 * detail screen shows.
 * Both tiers of the pipeline are covered: the base candidates (past
 * 24h) and the discovery tier (14–30 days ago) count engagement the
 * same raw way, so both get the reachable-only count.
 *
 * Both directions are exercised through the real route handlers, with a
 * short-lived synthetic test JWT. Only the server-only environment
 * marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { getRedisClient, invalidateCache } from '@feed/api';
import { comments, db, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ForYouResponse = {
  success: boolean;
  stories: Array<{
    storyKey: string;
    posts: Array<{ id: string; commentCount: number }>;
  }>;
  nextCursor?: string | null;
};

type PostDetailResponse = {
  data: { id: string; commentCount: number };
};

let viewerId: string;
let authorId: string;
let commenterId: string;
let postId: string;
let controlPostId: string;
let discoveryPostId: string;
let token: string;
const ownedUserIds: string[] = [];
const ownedPostIds: string[] = [];
const ownedCommentIds: string[] = [];

let getForYou: (request: NextRequest) => Promise<Response>;
let getPostDetail: (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

function findStoryPost(body: ForYouResponse | null, targetId: string) {
  if (!body || !('stories' in body)) return undefined;
  for (const story of body.stories) {
    const post = story.posts.find((p) => p.id === targetId);
    if (post) return post;
  }
  return undefined;
}

async function fetchForYouPage(token: string, cursor?: string | null) {
  const url = cursor
    ? `http://localhost/api/feed/for-you?limit=20&cursor=${encodeURIComponent(cursor)}`
    : 'http://localhost/api/feed/for-you?limit=20';
  const request = new NextRequest(
    new Request(url, { headers: { authorization: `Bearer ${token}` } })
  );
  const response = await getForYou(request);
  const body = (await response.json().catch(() => null)) as
    | ForYouResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function findForYouPost(token: string, targetId: string) {
  let cursor: string | null | undefined;
  for (let page = 0; page < 10; page++) {
    const { status, body } = await fetchForYouPage(token, cursor);
    expect(status).toBe(200);
    const found = findStoryPost(body as ForYouResponse, targetId);
    if (found) return found;
    const next = (body as ForYouResponse)?.nextCursor;
    if (!next) return undefined;
    cursor = next;
  }
  return undefined;
}

async function fetchPostDetail(token: string, targetId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${targetId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  const response = await getPostDetail(request, {
    params: Promise.resolve({ id: targetId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function clearForYouSnapshots() {
  if (getRedisClient()) {
    throw new Error('The For You fixture requires an in-process cache');
  }
  await invalidateCache('feed:for-you:v3:base', { namespace: 'feed' });
  await invalidateCache('feed:for-you:discovery:v1', { namespace: 'feed' });
  await invalidateCache(`feed:for-you:ranked:v2:${viewerId}`);
  await invalidateCache(`feed:for-you:enrichment:${viewerId}`, {
    namespace: 'feed',
  });
}

beforeAll(async () => {
  ({ GET: getForYou } = await import(
    '../../../apps/web/src/app/api/feed/for-you/route'
  ));
  ({ GET: getPostDetail } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));

  [viewerId, authorId, commenterId, postId, controlPostId, discoveryPostId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const commentIds = await Promise.all(
    Array.from({ length: 9 }, () => generateSnowflakeId())
  );
  ownedCommentIds.push(...commentIds);
  const [visibleA, visibleB, visibleReply, deletedParent, orphanReply, controlComment, discVisible, discDeletedParent, discOrphan] =
    commentIds as [string, string, string, string, string, string, string, string, string];

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  token = await new SignJWT({ sub: `fycc-${viewerId}`, userId: viewerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(secret));

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);
  // Discovery tier covers 14–30 days ago; the base tier only the past 24h.
  const discoveryTime = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

  const createdUsers = await db
    .insert(users)
    .values([
      {
        id: viewerId,
        username: `fycc-v-${viewerId}`,
        displayName: 'ForYou Count Fixture Viewer',
        stewardId: `fycc-${viewerId}`,
        updatedAt: now,
      },
      {
        id: authorId,
        username: `fycc-a-${authorId}`,
        displayName: 'ForYou Count Fixture Author',
        updatedAt: now,
      },
      {
        id: commenterId,
        username: `fycc-c-${commenterId}`,
        displayName: 'ForYou Count Fixture Commenter',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  ownedUserIds.push(...createdUsers.map((row) => row.id));

  const createdPosts = await db
    .insert(posts)
    .values([
      {
        id: postId,
        content: 'fixture post for for-you reachable comment counts',
        authorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: controlPostId,
        content: 'control post for for-you reachable comment counts',
        authorId,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: discoveryPostId,
        content: 'discovery-tier post for for-you reachable comment counts',
        authorId,
        timestamp: discoveryTime,
        createdAt: discoveryTime,
      },
    ])
    .returning({ id: posts.id });
  ownedPostIds.push(...createdPosts.map((row) => row.id));

  // Visible tree: two top-level comments + one reply to a visible parent.
  // Unreachable: a reply under a soft-deleted parent. The raw
  // deletedAt-only count is 4; the reachable count is 3.
  await db.insert(comments).values([
    {
      id: visibleA,
      content: 'visible comment a',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleB,
      content: 'visible comment b',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: visibleReply,
      content: 'visible reply to a',
      postId,
      authorId: commenterId,
      parentCommentId: visibleA,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: deletedParent,
      content: 'soft-deleted parent comment',
      postId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: earlier,
    },
    {
      id: orphanReply,
      content: 'reply under the deleted parent',
      postId,
      authorId: commenterId,
      parentCommentId: deletedParent,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    {
      id: controlComment,
      content: 'control comment',
      postId: controlPostId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: earlier,
      updatedAt: earlier,
      deletedAt: null,
    },
    // Discovery tier: one visible comment + one reply under a
    // soft-deleted parent. Raw count is 2; reachable count is 1.
    {
      id: discVisible,
      content: 'discovery visible comment',
      postId: discoveryPostId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: discoveryTime,
      updatedAt: discoveryTime,
      deletedAt: null,
    },
    {
      id: discDeletedParent,
      content: 'discovery soft-deleted parent comment',
      postId: discoveryPostId,
      authorId: commenterId,
      parentCommentId: null,
      createdAt: discoveryTime,
      updatedAt: discoveryTime,
      deletedAt: discoveryTime,
    },
    {
      id: discOrphan,
      content: 'discovery reply under the deleted parent',
      postId: discoveryPostId,
      authorId: commenterId,
      parentCommentId: discDeletedParent,
      createdAt: discoveryTime,
      updatedAt: discoveryTime,
      deletedAt: null,
    },
  ]);

  await clearForYouSnapshots();
});

afterAll(async () => {
  if (ownedCommentIds.length > 0) {
    await db.delete(comments).where(inArray(comments.id, ownedCommentIds));
  }
  if (ownedPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, ownedPostIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
  await clearForYouSnapshots();

  if (ownedCommentIds.length > 0) {
    const [leftover] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(inArray(comments.id, ownedCommentIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
  if (ownedPostIds.length > 0) {
    const [leftover] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.id, ownedPostIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
  if (ownedUserIds.length > 0) {
    const [leftover] = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ownedUserIds))
      .limit(1);
    expect(leftover).toBeUndefined();
  }
});

describe('For You card comment counts', () => {
  it('counts only reachable comments on the card', async () => {
    const card = await findForYouPost(token, postId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(3);
  });

  it('agrees with the post detail count (control)', async () => {
    const detail = await fetchPostDetail(token, postId);
    expect(detail.status).toBe(200);
    const body = detail.body as PostDetailResponse;
    expect(body.data.commentCount).toBe(3);
  });

  it('counts a fully visible thread exactly (control post)', async () => {
    const card = await findForYouPost(token, controlPostId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(1);
    const detail = await fetchPostDetail(token, controlPostId);
    expect(detail.status).toBe(200);
    expect((detail.body as PostDetailResponse).data.commentCount).toBe(1);
  });

  it('counts only reachable comments on a discovery-tier card', async () => {
    const card = await findForYouPost(token, discoveryPostId);
    expect(card).toBeDefined();
    expect(card?.commentCount).toBe(1);
  });
});

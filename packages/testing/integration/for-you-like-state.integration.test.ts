/**
 * GET /api/feed/for-you against a real database: the viewer's own like
 * state (isLiked) on a post must reflect a like/unlike the moment it
 * happens, the same way it already does on GET /api/posts/[id] and in
 * the Stories tab.
 *
 * The like route states the contract for Stories: it busts the
 * narrative enrichment cache on like/unlike "so users see their own
 * interactions reflected immediately" (narrativeEnrichmentKey is
 * documented the same way in the cache service). The For You feed has
 * two caches of its own that carry the viewer's like state — the
 * per-user enrichment snapshot inside buildForYouFeed (30s) and the
 * per-user ranked result the route serves (60s) — and neither is
 * invalidated anywhere, so a like placed from any other surface (or an
 * unlike) leaves the For You tab showing the pre-action state until
 * the snapshots expire.
 *
 * Both directions are exercised through the real route handlers:
 * warm the viewer's For You snapshot, like (or unlike) through
 * POST/DELETE /api/posts/[id]/like, confirm the post detail route
 * already reflects the change, then re-read For You.
 *
 * Auth uses a self-signed Steward JWT (dev fallback secret), the same
 * pattern as following-feed-comment-count. The only stub is the
 * `server-only` marker package.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, posts, reactions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ForYouResponse = {
  success: boolean;
  stories: Array<{
    storyKey: string;
    posts: Array<{ id: string; isLiked: boolean; likeCount: number }>;
  }>;
};

type PostDetailResponse = {
  data: { id: string; isLiked: boolean; likeCount: number };
};

let authorA: string;
let viewerA: string;
let postA: string;
let tokenA: string;
let authorB: string;
let viewerB: string;
let postB: string;
let tokenB: string;

let getForYou: typeof import('../../../apps/web/src/app/api/feed/for-you/route').GET;
let getPostDetail: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
let postLike: typeof import('../../../apps/web/src/app/api/posts/[id]/like/route').POST;
let deleteLike: typeof import('../../../apps/web/src/app/api/posts/[id]/like/route').DELETE;

async function signToken(stewardId: string): Promise<string> {
  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  return new SignJWT({ userId: stewardId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

async function fetchForYou(token: string) {
  const request = new NextRequest(
    new Request('http://localhost/api/feed/for-you'),
    { headers: { authorization: `Bearer ${token}` } }
  );
  const response = await getForYou(request);
  const body = (await response.json().catch(() => null)) as
    | ForYouResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

function findStoryPost(body: ForYouResponse | null, postId: string) {
  if (!body || !('stories' in body)) return undefined;
  for (const story of body.stories) {
    const post = story.posts.find((p) => p.id === postId);
    if (post) return post;
  }
  return undefined;
}

async function fetchPostDetail(token: string, postId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}`),
    { headers: { authorization: `Bearer ${token}` } }
  );
  const response = await getPostDetail(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as
    | PostDetailResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function callLike(
  handler: typeof postLike,
  token: string,
  postId: string
) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/like`),
    { headers: { authorization: `Bearer ${token}` } }
  );
  const response = await handler(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { isLiked: boolean; likeCount: number };
  } | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET: getForYou } = await import(
    '../../../apps/web/src/app/api/feed/for-you/route'
  ));
  ({ GET: getPostDetail } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  ));
  ({ POST: postLike, DELETE: deleteLike } = await import(
    '../../../apps/web/src/app/api/posts/[id]/like/route'
  ));

  [authorA, viewerA, postA, authorB, viewerB, postB] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  tokenA = await signToken(`f50a-${viewerA}`);
  tokenB = await signToken(`f50b-${viewerB}`);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: authorA,
      username: `f50a-author-${authorA}`,
      displayName: 'F50 Author A',
      updatedAt: now,
    },
    {
      id: viewerA,
      username: `f50a-viewer-${viewerA}`,
      displayName: 'F50 Viewer A',
      stewardId: `f50a-${viewerA}`,
      updatedAt: now,
    },
    {
      id: authorB,
      username: `f50b-author-${authorB}`,
      displayName: 'F50 Author B',
      updatedAt: now,
    },
    {
      id: viewerB,
      username: `f50b-viewer-${viewerB}`,
      displayName: 'F50 Viewer B',
      stewardId: `f50b-${viewerB}`,
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values([
    {
      id: postA,
      content: 'f50 fixture post for the like direction',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postB,
      content: 'f50 fixture post for the unlike direction',
      authorId: authorB,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  // Scenario B starts already-liked, recorded directly in the reaction
  // table (the same row the like route would have written).
  await db.insert(reactions).values({
    id: await generateSnowflakeId(),
    postId: postB,
    userId: viewerB,
    type: 'like',
    createdAt: earlier,
  });
});

afterAll(async () => {
  await db.delete(reactions).where(inArray(reactions.postId, [postA, postB]));
  await db.delete(posts).where(inArray(posts.id, [postA, postB]));
  await db
    .delete(users)
    .where(inArray(users.id, [authorA, viewerA, authorB, viewerB]));
});

describe('For You viewer like state', () => {
  it('reflects a like placed through the like route immediately', async () => {
    // Warm the viewer's For You snapshots before the like exists.
    const warm = await fetchForYou(tokenA);
    expect(warm.status).toBe(200);
    const before = findStoryPost(warm.body as ForYouResponse, postA);
    expect(before).toBeDefined();
    expect(before?.isLiked).toBe(false);

    const liked = await callLike(postLike, tokenA, postA);
    expect(liked.status).toBe(200);
    expect(liked.body?.data?.isLiked).toBe(true);

    // Control: the post detail route already reflects the like.
    const detail = await fetchPostDetail(tokenA, postA);
    expect(detail.status).toBe(200);
    expect(detail.body?.data?.isLiked).toBe(true);
    expect(detail.body?.data?.likeCount).toBe(1);

    // The For You tab must show the same state right away.
    const after = await fetchForYou(tokenA);
    expect(after.status).toBe(200);
    const afterPost = findStoryPost(after.body as ForYouResponse, postA);
    expect(afterPost).toBeDefined();
    expect(afterPost?.isLiked).toBe(true);
  });

  it('reflects an unlike placed through the like route immediately', async () => {
    // Warm the viewer's For You snapshots with the like in place.
    const warm = await fetchForYou(tokenB);
    expect(warm.status).toBe(200);
    const before = findStoryPost(warm.body as ForYouResponse, postB);
    expect(before).toBeDefined();
    expect(before?.isLiked).toBe(true);

    const unliked = await callLike(deleteLike, tokenB, postB);
    expect(unliked.status).toBe(200);

    // Control: the post detail route already reflects the unlike.
    const detail = await fetchPostDetail(tokenB, postB);
    expect(detail.status).toBe(200);
    expect(detail.body?.data?.isLiked).toBe(false);
    expect(detail.body?.data?.likeCount).toBe(0);

    // The For You tab must show the same state right away.
    const after = await fetchForYou(tokenB);
    expect(after.status).toBe(200);
    const afterPost = findStoryPost(after.body as ForYouResponse, postB);
    expect(afterPost).toBeDefined();
    expect(afterPost?.isLiked).toBe(false);
  });
});

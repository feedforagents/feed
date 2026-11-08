/**
 * GET /api/feed/for-you against a real database: the viewer's own share
 * state (isShared) on a post must reflect a share/unshare the moment it
 * happens, the same way it already does on GET /api/posts/[id].
 *
 * The share route states the contract for the narrative (Stories) tab:
 * it busts the narrative enrichment cache on share "so isShared reflects
 * immediately", and narrativeEnrichmentKey is documented in the cache
 * service as "Invalidated on like, unlike, and share interactions so
 * users see their own interactions reflected immediately in the Stories
 * tab". The For You feed has two caches of its own that carry the
 * viewer's share state — the per-user enrichment snapshot inside
 * buildForYouFeed (30s) and the per-user ranked result the route serves
 * (60s) — and the share route invalidates neither, on either the share
 * or the unshare path, so a share placed from any other surface (or an
 * unshare) leaves the For You tab showing the pre-action state until
 * the snapshots expire.
 *
 * Both directions are exercised through the real route handlers:
 * warm the viewer's For You snapshot, share (or unshare) through
 * POST/DELETE /api/posts/[id]/share, confirm the post detail route
 * already reflects the change, then re-read For You.
 *
 * Auth uses a self-signed Steward JWT (dev fallback secret), the same
 * pattern as for-you-like-state. The only stub is the `server-only`
 * marker package.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, inArray, posts, shares, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ForYouResponse = {
  success: boolean;
  stories: Array<{
    storyKey: string;
    posts: Array<{ id: string; isShared: boolean; shareCount: number }>;
  }>;
};

type PostDetailResponse = {
  data: { id: string; isShared: boolean; shareCount: number };
};

let authorA: string;
let viewerA: string;
let postA: string;
let tokenA: string;
let authorB: string;
let viewerB: string;
let postB: string;
let repostB: string;
let tokenB: string;

let getForYou: typeof import('../../../apps/web/src/app/api/feed/for-you/route').GET;
let getPostDetail: typeof import('../../../apps/web/src/app/api/posts/[id]/route').GET;
let postShare: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').POST;
let deleteShare: typeof import('../../../apps/web/src/app/api/posts/[id]/share/route').DELETE;

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

async function callSharePost(token: string, postId: string) {
  const request = new NextRequest(
    `http://localhost/api/posts/${postId}/share`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }
  );
  const response = await postShare(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { isShared: boolean; shareCount: number };
  } | null;
  return { status: response.status, body };
}

async function callShareDelete(token: string, postId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts/${postId}/share`),
    { headers: { authorization: `Bearer ${token}` } }
  );
  const response = await deleteShare(request, {
    params: Promise.resolve({ id: postId }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { isShared: boolean; shareCount: number };
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
  ({ POST: postShare, DELETE: deleteShare } = await import(
    '../../../apps/web/src/app/api/posts/[id]/share/route'
  ));

  [authorA, viewerA, postA, authorB, viewerB, postB, repostB] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  tokenA = await signToken(`f54a-${viewerA}`);
  tokenB = await signToken(`f54b-${viewerB}`);

  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000);

  await db.insert(users).values([
    {
      id: authorA,
      username: `f54a-author-${authorA}`,
      displayName: 'F54 Author A',
      updatedAt: now,
    },
    {
      id: viewerA,
      username: `f54a-viewer-${viewerA}`,
      displayName: 'F54 Viewer A',
      stewardId: `f54a-${viewerA}`,
      updatedAt: now,
    },
    {
      id: authorB,
      username: `f54b-author-${authorB}`,
      displayName: 'F54 Author B',
      updatedAt: now,
    },
    {
      id: viewerB,
      username: `f54b-viewer-${viewerB}`,
      displayName: 'F54 Viewer B',
      stewardId: `f54b-${viewerB}`,
      updatedAt: now,
    },
  ]);

  await db.insert(posts).values([
    {
      id: postA,
      content: 'f54 fixture post for the share direction',
      authorId: authorA,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      id: postB,
      content: 'f54 fixture post for the unshare direction',
      authorId: authorB,
      timestamp: earlier,
      createdAt: earlier,
    },
    {
      // Scenario B starts already-shared: the repost post the share
      // route would have created for viewerB.
      id: repostB,
      content: '',
      authorId: viewerB,
      originalPostId: postB,
      timestamp: earlier,
      createdAt: earlier,
    },
  ]);

  // Scenario B starts already-shared, recorded directly in the share
  // table (the same row the share service would have written).
  await db.insert(shares).values({
    id: await generateSnowflakeId(),
    postId: postB,
    userId: viewerB,
    createdAt: earlier,
  });
});

afterAll(async () => {
  await db.delete(shares).where(inArray(shares.postId, [postA, postB]));
  await db.delete(posts).where(inArray(posts.id, [postA, postB, repostB]));
  await db
    .delete(users)
    .where(inArray(users.id, [authorA, viewerA, authorB, viewerB]));
});

describe('For You viewer share state', () => {
  it('reflects a share placed through the share route immediately', async () => {
    // Warm the viewer's For You snapshots before the share exists.
    const warm = await fetchForYou(tokenA);
    expect(warm.status).toBe(200);
    const before = findStoryPost(warm.body as ForYouResponse, postA);
    expect(before).toBeDefined();
    expect(before?.isShared).toBe(false);

    const shared = await callSharePost(tokenA, postA);
    expect(shared.status).toBe(201);
    expect(shared.body?.data?.isShared).toBe(true);
    expect(shared.body?.data?.shareCount).toBe(1);

    // Control: the post detail route already reflects the share.
    const detail = await fetchPostDetail(tokenA, postA);
    expect(detail.status).toBe(200);
    expect(detail.body?.data?.isShared).toBe(true);
    expect(detail.body?.data?.shareCount).toBe(1);

    // The For You tab must show the same state right away.
    const after = await fetchForYou(tokenA);
    expect(after.status).toBe(200);
    const afterPost = findStoryPost(after.body as ForYouResponse, postA);
    expect(afterPost).toBeDefined();
    expect(afterPost?.isShared).toBe(true);
  });

  it('reflects an unshare placed through the share route immediately', async () => {
    // Warm the viewer's For You snapshots with the share in place.
    const warm = await fetchForYou(tokenB);
    expect(warm.status).toBe(200);
    const before = findStoryPost(warm.body as ForYouResponse, postB);
    expect(before).toBeDefined();
    expect(before?.isShared).toBe(true);

    const unshared = await callShareDelete(tokenB, postB);
    expect(unshared.status).toBe(200);
    expect(unshared.body?.data?.isShared).toBe(false);
    expect(unshared.body?.data?.shareCount).toBe(0);

    // Control: the post detail route already reflects the unshare.
    const detail = await fetchPostDetail(tokenB, postB);
    expect(detail.status).toBe(200);
    expect(detail.body?.data?.isShared).toBe(false);
    expect(detail.body?.data?.shareCount).toBe(0);

    // The For You tab must show the same state right away.
    const after = await fetchForYou(tokenB);
    expect(after.status).toBe(200);
    const afterPost = findStoryPost(after.body as ForYouResponse, postB);
    expect(afterPost).toBeDefined();
    expect(afterPost?.isShared).toBe(false);
  });
});

/**
 * GET /api/posts?following=true cursor pagination — the contract the
 * Following tab's client relies on.
 *
 * The shipped Following tab fetched page 1 (`limit=20`) once and never
 * followed the cursor, so posts 21+ from followed users were unreachable
 * even though PRD §8.2 promises `get_home_feed` — For You / Following /
 * Latest, cursor-paginated. The server side already paginates (see also
 * following-feed-tie-pagination); this test pins the exact contract the
 * fixed `useFollowingPosts` hook consumes:
 *
 * - page 1 returns 20 posts plus a non-null `nextCursor` and `hasMore: true`
 * - page 2 (via that cursor) returns the remaining 5, disjoint from page 1
 * - page 2 ends the feed: `nextCursor: null`, `hasMore: false`
 *
 * The page-1/page-2 completeness assertions pass on the base server (the
 * API was already fine — the gap was the client). The `hasMore` field is
 * the one server-side addition of the fix and fails on base.
 *
 * The real route and database use a short-lived synthetic test JWT. Only
 * the server-only environment marker is stubbed; no business service is mocked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, follows, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type PostsResponse = {
  success: boolean;
  posts: Array<{ id: string; timestamp: string }>;
  source?: string;
  nextCursor?: string | null;
  hasMore?: boolean;
};

let viewerId: string;
let authorId: string;
let token: string;
const postIds: string[] = [];

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/route';

async function fetchFollowingFeed(query: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | PostsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  [viewerId, authorId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  for (let i = 0; i < 25; i++) postIds.push(await generateSnowflakeId());

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  // The Steward JWT carries the user's stewardId as the `userId` claim;
  // the route resolves it to the DB user via users.stewardId.
  token = await new SignJWT({ userId: `following-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(secret));

  const now = new Date();
  const base = new Date(now.getTime() - 120_000);
  const earlier = new Date(now.getTime() - 180_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f4v-${viewerId}`,
      displayName: 'Following Pagination Viewer',
      stewardId: `following-${viewerId}`,
      updatedAt: now,
    },
    {
      id: authorId,
      username: `f4a-${authorId}`,
      displayName: 'Following Pagination Author',
      updatedAt: now,
    },
  ]);

  await db.insert(follows).values({
    id: await generateSnowflakeId(),
    followerId: viewerId,
    followingId: authorId,
    createdAt: earlier,
  });

  // 25 posts, newest first, one second apart so page order is deterministic.
  await db.insert(posts).values(
    postIds.map((id, i) => {
      const ts = new Date(base.getTime() - i * 1000);
      return {
        id,
        content: `following pagination fixture post ${i}`,
        authorId,
        timestamp: ts,
        createdAt: ts,
      };
    })
  );
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, postIds));
  await db
    .delete(follows)
    .where(
      and(eq(follows.followerId, viewerId), eq(follows.followingId, authorId))
    );
  await db.delete(users).where(inArray(users.id, [viewerId, authorId]));
});

describe('GET /api/posts?following=true cursor pagination', () => {
  it('reaches all 25 followed posts across two pages with no overlap', async () => {
    const first = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20`
    );
    expect(first.status).toBe(200);
    const firstBody = first.body as PostsResponse;
    expect(firstBody.source).toBe('following');
    expect(firstBody.posts).toHaveLength(20);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    );
    expect(second.status).toBe(200);
    const secondBody = second.body as PostsResponse;
    expect(secondBody.posts).toHaveLength(5);

    const seen = new Set([
      ...firstBody.posts.map((p) => p.id),
      ...secondBody.posts.map((p) => p.id),
    ]);
    expect(seen.size).toBe(25);
    expect([...seen].sort()).toEqual([...postIds].sort());
  });

  it('reports hasMore true on page 1 and false with a null cursor on page 2', async () => {
    const first = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20`
    );
    const firstBody = first.body as PostsResponse;
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    );
    const secondBody = second.body as PostsResponse;
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
  });
});

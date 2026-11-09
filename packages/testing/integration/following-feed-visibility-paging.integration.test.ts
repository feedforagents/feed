/**
 * GET /api/posts?following=true against a real database: the Following
 * feed must apply its author exclusions before it cuts a page, the same
 * way every sibling feed does.
 *
 * Two exclusions are mishandled in the Following branch:
 *
 * - Test authors: the canonical `DatabaseService.getRecentPosts`
 *   excludes them in SQL before paginating with two conditions —
 *   `authorId NOT LIKE 'test-%'` and `NOT EXISTS (users.isTest)` — and
 *   the web favorites feed (#1670) drops both shapes from its candidate
 *   list up front. `getPostsForFollowing` only drops followed ids whose
 *   users row is flagged isTest (or a static test actor), so a followed
 *   author whose id starts with `test-` but whose users row is not
 *   flagged leaks onto the Following tab.
 *
 * - Muted authors: muting keeps the follow edge (blocking is what
 *   severs it), and the route computes the viewer's blocked/muted/
 *   blocked-by set — but it filters the page in memory *after*
 *   `getPostsForFollowing` has already spent the SQL `LIMIT` on the
 *   newest posts, which are the muted author's. The web Following tab
 *   fetches a single page (`limit=20&offset=0`) with no load-more, so
 *   visible posts behind a muted author's newest posts never reach
 *   the tab at all. #1712 makes the same before-paging fix for the
 *   main feed branches; the Following branch returns before that code.
 *
 * Fixture: the viewer follows a normal author (3 visible posts, plus
 * future-dated and soft-deleted controls), a `test-`-prefixed author
 * (users row present, isTest false), an isTest-flagged author, and a
 * muted author holding the three newest posts.
 *
 * The real route and database run against PostgreSQL with a
 * short-lived synthetic Steward JWT (the route's real session path).
 * Only the server-only environment marker is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, follows, inArray, posts, userMutes, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type FollowingResponse = {
  success: boolean;
  posts: Array<{ id: string; timestamp: string }>;
  source?: string;
  nextCursor?: string | null;
};

let viewerId: string;
let normalId: string;
let prefixedId: string;
let flaggedId: string;
let mutedId: string;
let token: string;
const visibleIds: string[] = []; // normal author's posts, newest first
const hiddenIds: string[] = []; // must never appear on any page
const allPostIds: string[] = [];
const allUserIds: string[] = [];

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/route';

async function fetchFollowingPage(limit: number, cursor?: string) {
  const params = new URLSearchParams({
    following: 'true',
    userId: viewerId,
    limit: String(limit),
  });
  if (cursor !== undefined) params.set('cursor', cursor);
  const request = new NextRequest(
    new Request(`http://localhost/api/posts?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as
    | FollowingResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body: body as FollowingResponse };
}

/**
 * Page through the feed the way a client does: resume with the
 * response's nextCursor when present, otherwise the last post's
 * timestamp. Returns every post id seen, in page order.
 */
async function traverseFollowingFeed(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const { status, body } = await fetchFollowingPage(limit, cursor);
    expect(status).toBe(200);
    const posts = body.posts ?? [];
    seen.push(...posts.map((p) => p.id));
    if (posts.length < limit) break;
    const last = posts[posts.length - 1];
    if (!last) break;
    cursor = body.nextCursor ?? last.timestamp;
  }
  return seen;
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  viewerId = await generateSnowflakeId();
  normalId = await generateSnowflakeId();
  prefixedId = `test-f102-${await generateSnowflakeId()}`;
  flaggedId = await generateSnowflakeId();
  mutedId = await generateSnowflakeId();
  allUserIds.push(viewerId, normalId, prefixedId, flaggedId, mutedId);

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  token = await new SignJWT({ userId: `f102-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  const stamp = new Date(now);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `f102v-${viewerId}`,
      displayName: 'Following Visibility Viewer',
      stewardId: `f102-${viewerId}`,
      updatedAt: stamp,
    },
    {
      id: normalId,
      username: `f102n-${normalId}`,
      displayName: 'Following Visibility Normal Author',
      updatedAt: stamp,
    },
    {
      // The #1670 'prefixed' shape: a real users row whose id starts
      // with 'test-' but that is NOT flagged isTest.
      id: prefixedId,
      username: `f102p-${prefixedId}`,
      displayName: 'Following Visibility Prefixed Author',
      isTest: false,
      updatedAt: stamp,
    },
    {
      id: flaggedId,
      username: `f102f-${flaggedId}`,
      displayName: 'Following Visibility Flagged Author',
      isTest: true,
      updatedAt: stamp,
    },
    {
      id: mutedId,
      username: `f102m-${mutedId}`,
      displayName: 'Following Visibility Muted Author',
      updatedAt: stamp,
    },
  ]);

  await db.insert(follows).values(
    await Promise.all(
      [normalId, prefixedId, flaggedId, mutedId].map(async (followingId) => ({
        id: await generateSnowflakeId(),
        followerId: viewerId,
        followingId,
        createdAt: at(120),
      }))
    )
  );

  // Muting keeps the follow edge; the muted author's posts must be
  // excluded when the page is cut, not after.
  await db.insert(userMutes).values({
    id: await generateSnowflakeId(),
    muterId: viewerId,
    mutedId,
  });

  const defs: Array<{
    author: string;
    minAgo: number;
    visible: boolean;
    deleted?: boolean;
  }> = [
    { author: mutedId, minAgo: 5, visible: false },
    { author: mutedId, minAgo: 8, visible: false },
    { author: prefixedId, minAgo: 10, visible: false },
    { author: mutedId, minAgo: 12, visible: false },
    { author: flaggedId, minAgo: 15, visible: false },
    { author: normalId, minAgo: -10, visible: false }, // future control
    { author: normalId, minAgo: 20, visible: false, deleted: true },
    { author: normalId, minAgo: 50, visible: true },
    { author: normalId, minAgo: 60, visible: true },
    { author: normalId, minAgo: 70, visible: true },
  ];
  for (const def of defs) {
    const id = await generateSnowflakeId();
    allPostIds.push(id);
    if (def.visible) visibleIds.push(id);
    else hiddenIds.push(id);
    await db.insert(posts).values({
      id,
      content: `following visibility fixture ${id}`,
      authorId: def.author,
      type: 'post',
      timestamp: at(def.minAgo),
      createdAt: at(def.minAgo),
      deletedAt: def.deleted ? at(1) : null,
    });
  }
});

afterAll(async () => {
  await db.delete(userMutes).where(eq(userMutes.muterId, viewerId));
  await db.delete(follows).where(eq(follows.followerId, viewerId));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/posts?following=true author exclusions', () => {
  it('shows only the normal author on a full page: no test-prefixed, flagged, muted, future or deleted posts', async () => {
    const { status, body } = await fetchFollowingPage(10);
    expect(status).toBe(200);
    expect(body.source).toBe('following');
    expect(body.posts.map((p) => p.id)).toEqual(visibleIds);
  });

  it('fills the first page with visible posts when a muted author holds the newest posts', async () => {
    const { status, body } = await fetchFollowingPage(2);
    expect(status).toBe(200);
    expect(body.posts.map((p) => p.id)).toEqual(visibleIds.slice(0, 2));
  });

  it('reaches every visible post exactly once when paged to the end', async () => {
    const seen = await traverseFollowingFeed(2);
    expect(seen).toEqual(visibleIds);
  });

  it('guard: future, deleted and isTest-flagged posts stay hidden', async () => {
    const { status, body } = await fetchFollowingPage(10);
    expect(status).toBe(200);
    const ids = body.posts.map((p) => p.id);
    // Controls that already pass on the base: the isTest-flagged,
    // future-dated and soft-deleted posts, and the muted author's
    // newest post (removed by the route's post-page filter when the
    // page is large enough to reach past it).
    expect(ids).not.toContain(allPostIds[4]!); // flagged
    expect(ids).not.toContain(allPostIds[5]!); // future
    expect(ids).not.toContain(allPostIds[6]!); // deleted
    expect(ids).not.toContain(allPostIds[0]!); // muted newest
  });
});

/**
 * GET /api/posts/feed/favorites against a real database: paging through
 * the whole favorites feed must reach every post exactly once.
 *
 * The route ordered pages by `createdAt DESC` alone. Posts written by a
 * single batch insert share one `createdAt` (Postgres `now()` is the
 * transaction timestamp, and `createdAt` defaults to it), so a batch of
 * generated posts forms a large tie group with no defined order. With
 * OFFSET paging, each page's top-N sort is free to pick a different
 * subset of the tie group: measured on the base, a 340-post feed with a
 * 300-post tie group returned 340 rows at limit=25 whose set contained
 * 125 duplicates and missed 125 posts entirely — those posts are
 * unreachable no matter how far the user pages, while `total` still
 * promises 340.
 *
 * Authentication uses the route's real session path: a short-lived
 * Steward JWT (HS256, issuer "steward") exactly as issued at sign-in and
 * resolved through `optionalAuth`'s user lookup — the `steward:test:`
 * harness token is not accepted by this route.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, favorites, inArray, posts, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type FeedResponse = {
  success: boolean;
  posts: Array<{ id: string; createdAt: string }>;
  total: number;
  hasMore: boolean;
};

let GET: (request: NextRequest) => Promise<Response>;
const routePath = '../../../apps/web/src/app/api/posts/feed/favorites/route';

let viewerId: string;
let token: string;
const authorIds: string[] = [];
const allPostIds: string[] = [];
const tieNewIds: string[] = [];
const tieOldIds: string[] = [];

async function fetchPage(limit: number, page: number) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/posts/feed/favorites?limit=${limit}&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } }
    )
  );
  const response = await GET(request);
  const body = (await response.json().catch(() => null)) as FeedResponse;
  return { status: response.status, body };
}

async function traverse(limit: number) {
  const seen: Array<{ id: string; createdAt: string }> = [];
  let total = -1;
  for (let page = 1; page <= 100; page++) {
    const { status, body } = await fetchPage(limit, page);
    expect(status).toBe(200);
    total = body.total;
    seen.push(...body.posts);
    if (!body.hasMore) break;
  }
  return { seen, total };
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  viewerId = await generateSnowflakeId();
  const [authorA, authorB] = [
    await generateSnowflakeId(),
    await generateSnowflakeId(),
  ];
  authorIds.push(authorA, authorB);

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  token = await new SignJWT({ userId: `g32fav-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

  const now = new Date();
  await db.insert(users).values([
    {
      id: viewerId,
      username: `g32fv-${viewerId}`,
      displayName: 'Favorites Feed Fixture Viewer',
      stewardId: `g32fav-${viewerId}`,
      updatedAt: now,
    },
    {
      id: authorA,
      username: `g32fa-${authorA}`,
      displayName: 'Favorites Feed Fixture Author A',
      updatedAt: now,
    },
    {
      id: authorB,
      username: `g32fb-${authorB}`,
      displayName: 'Favorites Feed Fixture Author B',
      updatedAt: now,
    },
  ]);

  await db.insert(favorites).values([
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorA,
      createdAt: now,
    },
    {
      id: await generateSnowflakeId(),
      userId: viewerId,
      targetUserId: authorB,
      createdAt: now,
    },
  ]);

  // Two tie groups that share one createdAt each, written as one
  // multi-row insert per group — the same shape as a batch generation
  // write, where every row takes the transaction's now() as createdAt.
  // `timestamp` (the display time) still differs per post.
  const tieNew = new Date(now.getTime() - 60_000);
  const tieOld = new Date(now.getTime() - 3_600_000);
  const newRows: Array<typeof posts.$inferInsert> = [];
  for (let i = 0; i < 300; i++) {
    const id = await generateSnowflakeId();
    tieNewIds.push(id);
    newRows.push({
      id,
      content: `favorites feed tie-new post ${i}`,
      authorId: i % 2 === 0 ? authorA : authorB,
      timestamp: new Date(tieNew.getTime() - i * 1000),
      createdAt: tieNew,
    });
  }
  const oldRows: Array<typeof posts.$inferInsert> = [];
  for (let i = 0; i < 40; i++) {
    const id = await generateSnowflakeId();
    tieOldIds.push(id);
    oldRows.push({
      id,
      content: `favorites feed tie-old post ${i}`,
      authorId: i % 2 === 0 ? authorB : authorA,
      timestamp: new Date(tieOld.getTime() - i * 1000),
      createdAt: tieOld,
    });
  }
  await db.insert(posts).values(newRows);
  await db.insert(posts).values(oldRows);
  allPostIds.push(...tieNewIds, ...tieOldIds);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(favorites).where(eq(favorites.userId, viewerId));
  await db.delete(users).where(inArray(users.id, [viewerId, ...authorIds]));
  token = '';
});

describe('GET /api/posts/feed/favorites pagination completeness', () => {
  it('reaches every post exactly once at limit=25', async () => {
    const { seen, total } = await traverse(25);
    const ids = seen.map((p) => p.id);
    expect(total).toBe(allPostIds.length);
    expect(ids.length).toBe(allPostIds.length);
    expect(new Set(ids).size).toBe(allPostIds.length);
    expect(new Set(ids)).toEqual(new Set(allPostIds));
  }, 30_000);

  it('reaches every post exactly once at limit=7', async () => {
    const { seen, total } = await traverse(7);
    const ids = seen.map((p) => p.id);
    expect(total).toBe(allPostIds.length);
    expect(ids.length).toBe(allPostIds.length);
    expect(new Set(ids).size).toBe(allPostIds.length);
    expect(new Set(ids)).toEqual(new Set(allPostIds));
  }, 30_000);

  it('returns the same order on repeated traversals', async () => {
    const first = (await traverse(25)).seen.map((p) => p.id);
    const second = (await traverse(25)).seen.map((p) => p.id);
    expect(second).toEqual(first);
  }, 30_000);

  it('keeps the newer tie group ahead of the older one', async () => {
    const { seen } = await traverse(100);
    const ids = seen.map((p) => p.id);
    const lastNew = Math.max(...tieNewIds.map((id) => ids.indexOf(id)));
    const firstOld = Math.min(...tieOldIds.map((id) => ids.indexOf(id)));
    expect(lastNew).toBeGreaterThanOrEqual(0);
    expect(firstOld).toBeGreaterThan(lastNew);
    const stamps = seen.map((p) => new Date(p.createdAt).getTime());
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeLessThanOrEqual(stamps[i - 1]!);
    }
  }, 30_000);
});

/**
 * GET /api/posts?following=true against a real database: paging through
 * the whole Following feed must reach every visible post exactly once.
 *
 * The Following branch ordered pages by `timestamp DESC` alone and
 * resumed with `timestamp < cursor`. Posts that share one timestamp form
 * a tie group with no defined order, and every tied post that did not fit
 * on the page where the tie started falls behind the strict `<` cursor
 * and can never be returned by any later page. Equal timestamps are
 * ordinary data here, not an edge invention: `posts.timestamp` defaults
 * to the database transaction timestamp (`defaultNow()`), so one batch
 * insert stamps every row with the same value, and engine post creation
 * also stamps posts from millisecond-precision JS `Date` values.
 *
 * The branch also returned no continuation cursor of its own, so the
 * only resume value a client could derive was the last post's timestamp
 * — exactly the value that drops the rest of the tie group.
 *
 * Fixture: the viewer follows one author who has 5 posts sharing a
 * single timestamp and 2 posts at distinct older times, written in one
 * batch insert. One soft-deleted post (newer than the tie group) and
 * one future-dated post are controls — they must stay invisible on
 * every page.
 *
 * The real route and database run against PostgreSQL with a short-lived
 * synthetic Steward JWT (the route's real session path). Only the
 * server-only environment marker is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, follows, inArray, posts, users } from '@feed/db';
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
let authorId: string;
let token: string;
const tieIds: string[] = [];
const olderIds: string[] = [];
const hiddenIds: string[] = [];
const allPostIds: string[] = [];
let tieTimestampIso: string;

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
 * Page through the feed the way a client does: start with no cursor,
 * then resume with the continuation the response provides (its
 * nextCursor when present, otherwise the last post's timestamp).
 * Returns every post id seen, in page order.
 */
async function traverseFollowingFeed(limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 12; page++) {
    const { status, body } = await fetchFollowingPage(limit, cursor);
    expect(status).toBe(200);
    expect(body.source).toBe('following');
    if (body.posts.length === 0) break;
    seen.push(...body.posts.map((p) => p.id));
    const last = body.posts[body.posts.length - 1]!;
    cursor = body.nextCursor ?? last.timestamp;
  }
  return seen;
}

beforeAll(async () => {
  ({ GET } = await import(routePath));

  [viewerId, authorId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const generated = await Promise.all(
    Array.from({ length: 9 }, () => generateSnowflakeId())
  );
  tieIds.push(...generated.slice(0, 5));
  olderIds.push(...generated.slice(5, 7));
  hiddenIds.push(...generated.slice(7, 9));
  allPostIds.push(...generated);

  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  token = await new SignJWT({ userId: `following-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));

  const now = Date.now();
  const tieAt = new Date(now - 10 * 60_000);
  tieTimestampIso = tieAt.toISOString();
  const older1At = new Date(now - 70 * 60_000);
  const older2At = new Date(now - 130 * 60_000);
  const deletedAt = new Date(now - 5 * 60_000);
  const futureAt = new Date(now + 60 * 60_000);
  const createdBase = new Date(now - 10 * 60_000);

  await db.insert(users).values([
    {
      id: viewerId,
      username: `g35v-${viewerId}`,
      displayName: 'Following Tie Viewer',
      stewardId: `following-${viewerId}`,
      updatedAt: createdBase,
    },
    {
      id: authorId,
      username: `g35a-${authorId}`,
      displayName: 'Following Tie Author',
      updatedAt: createdBase,
    },
  ]);

  await db.insert(follows).values({
    id: await generateSnowflakeId(),
    followerId: viewerId,
    followingId: authorId,
    createdAt: createdBase,
  });

  // One batch insert, the way batch post creation writes: the five tie
  // posts carry one shared timestamp value.
  await db.insert(posts).values([
    ...tieIds.map((id, i) => ({
      id,
      content: `following tie post ${i}`,
      authorId,
      timestamp: tieAt,
      createdAt: tieAt,
    })),
    {
      id: olderIds[0]!,
      content: 'following older post 1',
      authorId,
      timestamp: older1At,
      createdAt: older1At,
    },
    {
      id: olderIds[1]!,
      content: 'following older post 2',
      authorId,
      timestamp: older2At,
      createdAt: older2At,
    },
    {
      id: hiddenIds[0]!,
      content: 'following soft-deleted post',
      authorId,
      timestamp: deletedAt,
      createdAt: deletedAt,
      deletedAt: new Date(now - 4 * 60_000),
    },
    {
      id: hiddenIds[1]!,
      content: 'following future post',
      authorId,
      timestamp: futureAt,
      createdAt: futureAt,
    },
  ]);
});

afterAll(async () => {
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db
    .delete(follows)
    .where(
      and(eq(follows.followerId, viewerId), eq(follows.followingId, authorId))
    );
  await db.delete(users).where(inArray(users.id, [viewerId, authorId]));
  token = '';
});

describe('GET /api/posts?following=true pagination across equal timestamps', () => {
  it('reaches every visible post exactly once when a page boundary falls inside a tie group', async () => {
    const seen = await traverseFollowingFeed(2);
    // After the fix the order is fully determined: timestamp desc,
    // then id desc (snowflake ids increase with creation order).
    const expected = [...[...tieIds].reverse(), olderIds[0]!, olderIds[1]!];
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  }, 30_000);

  it('keeps legacy timestamp-only cursors working for distinct timestamps', async () => {
    const { status, body } = await fetchFollowingPage(10, tieTimestampIso);
    expect(status).toBe(200);
    expect(body.posts.map((p) => p.id)).toEqual([olderIds[0]!, olderIds[1]!]);
  });

  it('never returns the soft-deleted or future-dated control posts', async () => {
    const { status, body } = await fetchFollowingPage(50);
    expect(status).toBe(200);
    const ids = body.posts.map((p) => p.id);
    expect(ids).toHaveLength(7);
    for (const hidden of hiddenIds) {
      expect(ids).not.toContain(hidden);
    }
  });
});

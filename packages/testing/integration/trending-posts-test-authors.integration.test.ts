/**
 * PRD §6.1 / §12 / MVP phase 5: test accounts are not real people, so the
 * public trending-posts widget must not return their posts — the same rule
 * every sibling post list applies (main feed, following feed, single-tag
 * page, grouped trending, hot feed). Uses the real route and PostgreSQL.
 * Only the server-side clock moves into the fixture window.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setSystemTime,
} from 'bun:test';
import { optionalAuth } from '@feed/api';
import { db, inArray, posts, reactions, sql, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/trending-posts/route';

const userIds: string[] = [];
const postIds: string[] = [];
const reactionIds: string[] = [];
let normalAuthorId: string;
let testFlagAuthorId: string;
let prefixAuthorId: string;
let noUserAuthorId: string;
let viewerId: string;
let normalPostId: string;
let noUserPostId: string;
let testFlagPostId: string;
let prefixPostId: string;
let deletedPostId: string;
let futurePostId: string;
let token: string;
let fixtureTime: Date;

interface TrendingPost {
  id: string;
  authorId: string;
  authorName: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  trendingScore: number;
}

beforeAll(async () => {
  // The widget reads a 24-hour window. Place the fixture before every
  // existing row so the window contains only these posts, without deleting
  // or modifying rows owned by other suites.
  const [bounds] = await db
    .select({ oldest: sql<string | null>`min(${posts.timestamp})::text` })
    .from(posts);
  const oldest = bounds?.oldest
    ? new Date(bounds.oldest).getTime()
    : Date.now();
  fixtureTime = new Date(Math.min(Date.now(), oldest) - 48 * 60 * 60 * 1000);

  const authorIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  normalAuthorId = authorIds[0]!;
  testFlagAuthorId = authorIds[1]!;
  prefixAuthorId = `test-tpa-${authorIds[2]!}`;
  noUserAuthorId = `npc-tpa-${authorIds[2]!}`;

  const likerIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  viewerId = likerIds[0]!;
  const now = fixtureTime;
  await db.insert(users).values([
    {
      id: normalAuthorId,
      username: `tpa${normalAuthorId}`,
      displayName: 'Trending author fixture',
      isTest: false,
      updatedAt: now,
    },
    {
      id: testFlagAuthorId,
      username: `tpa${testFlagAuthorId}`,
      displayName: 'Trending test-flagged fixture',
      isTest: true,
      updatedAt: now,
    },
    {
      // Prefix rule is independent of the flag: isTest stays false here.
      id: prefixAuthorId,
      username: `tpa${prefixAuthorId}`,
      displayName: 'Trending prefix fixture',
      isTest: false,
      updatedAt: now,
      stewardId: `trending-${prefixAuthorId}`,
    },
    ...likerIds.map((id) => ({
      id,
      username: `tpa${id}`,
      displayName: 'Trending liker fixture',
      isTest: false,
      updatedAt: now,
      stewardId: id === viewerId ? `trending-${viewerId}` : null,
    })),
  ]);
  userIds.push(normalAuthorId, testFlagAuthorId, prefixAuthorId, ...likerIds);

  token = await new SignJWT({ userId: `trending-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setNotBefore(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 300)
    .sign(
      new TextEncoder().encode(
        process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod'
      )
    );

  const postIdsGenerated = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  normalPostId = postIdsGenerated[0]!;
  noUserPostId = postIdsGenerated[1]!;
  testFlagPostId = postIdsGenerated[2]!;
  prefixPostId = postIdsGenerated[3]!;
  deletedPostId = postIdsGenerated[4]!;
  futurePostId = postIdsGenerated[5]!;
  await db.insert(posts).values([
    {
      id: normalPostId,
      content: 'Trending test-author fixture: visible',
      authorId: normalAuthorId,
      timestamp: now,
      createdAt: now,
    },
    {
      id: noUserPostId,
      content: 'Trending test-author fixture: no user row',
      authorId: noUserAuthorId,
      timestamp: now,
      createdAt: now,
    },
    {
      id: testFlagPostId,
      content: 'Trending test-author fixture: isTest author',
      authorId: testFlagAuthorId,
      timestamp: now,
      createdAt: now,
    },
    {
      id: prefixPostId,
      content: 'Trending test-author fixture: test- prefix author',
      authorId: prefixAuthorId,
      timestamp: now,
      createdAt: now,
    },
    {
      id: deletedPostId,
      content: 'Trending test-author fixture: soft-deleted',
      authorId: normalAuthorId,
      timestamp: now,
      createdAt: now,
      deletedAt: now,
    },
    {
      id: futurePostId,
      content: 'Trending test-author fixture: future',
      authorId: normalAuthorId,
      timestamp: new Date(now.getTime() + 60_000),
      createdAt: now,
    },
  ]);
  postIds.push(...postIdsGenerated);

  // Enough engagement that the excluded posts would outrank the visible
  // ones if the author filter were missing.
  const engagement: Array<[string, number]> = [
    [normalPostId, 3],
    [noUserPostId, 4],
    [testFlagPostId, 6],
    [prefixPostId, 5],
    [deletedPostId, 2],
  ];
  for (const [postId, likes] of engagement) {
    for (const userId of likerIds.slice(0, likes)) {
      const id = await generateSnowflakeId();
      await db.insert(reactions).values({ id, postId, userId, type: 'like' });
      reactionIds.push(id);
    }
  }
});

afterAll(async () => {
  if (reactionIds.length) {
    await db.delete(reactions).where(inArray(reactions.id, reactionIds));
  }
  if (postIds.length) await db.delete(posts).where(inArray(posts.id, postIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
});

async function fetchTrending(signedIn: boolean): Promise<TrendingPost[]> {
  const request = new NextRequest(
    'http://localhost/api/feed/widgets/trending-posts',
    { headers: signedIn ? { Authorization: `Bearer ${token}` } : undefined }
  );
  // Tokens are valid only inside the five-minute synthetic window and the
  // widget window is anchored to the same clock. Restore even on failure.
  setSystemTime(fixtureTime);
  try {
    const auth = await optionalAuth(request);
    if (signedIn) expect(auth?.userId).toBe(viewerId);
    else expect(auth).toBeNull();
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { posts: TrendingPost[] };
    return body.posts;
  } finally {
    setSystemTime();
  }
}

describe('Trending posts widget excludes test authors', () => {
  for (const signedIn of [false, true]) {
    const mode = signedIn ? 'signed-in' : 'public';
    it(`returns only eligible fixture posts (${mode})`, async () => {
      const result = await fetchTrending(signedIn);
      const ids = result.map((post) => post.id);
      expect(ids).toContain(normalPostId);
      expect(ids).toContain(noUserPostId);
      expect(ids).not.toContain(testFlagPostId);
      expect(ids).not.toContain(prefixPostId);
      expect(ids).not.toContain(deletedPostId);
      expect(ids).not.toContain(futurePostId);
      expect([...ids].sort()).toEqual([normalPostId, noUserPostId].sort());
    });
    it(`keeps engagement and author metadata for visible posts (${mode})`, async () => {
      const result = await fetchTrending(signedIn);
      const normal = result.find((post) => post.id === normalPostId);
      expect(normal?.likeCount).toBe(3);
      expect(normal?.commentCount).toBe(0);
      expect(normal?.authorName).toBe('Trending author fixture');
      const noUser = result.find((post) => post.id === noUserPostId);
      expect(noUser?.likeCount).toBe(4);
      // No user row (NPC actor / organization): falls back to the raw id.
      expect(noUser?.authorName).toBe(noUserAuthorId);
    });
  }
});

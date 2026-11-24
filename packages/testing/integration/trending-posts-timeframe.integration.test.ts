/**
 * Trending posts widget must honor the `timeframe` query parameter.
 *
 * Basis: the route's own OpenAPI doc (`timeframe`, "Time window for
 * trending calculation", default `24h`) + `TrendingPostsQuerySchema`
 * (`1h | 6h | 24h | 7d`, default `24h`) + merged precedent 6900e85dc
 * (SYMBaiEX, "fix: honor upcoming event timeframes"), which fixed the
 * same "parse the parameter but never apply it to the window" defect in
 * the sibling upcoming-events widget. Uses the real route and PostgreSQL.
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
import {
  dbWrite,
  gameOnboarding,
  inArray,
  or,
  posts,
  reactions,
  sql,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { GET } from '../../../apps/web/src/app/api/feed/widgets/trending-posts/route';

type FixtureRow = { id: string; version: string };
const rowVersion = sql<string>`xmin::text || ':' || ctid::text`;
const ownedUsers: FixtureRow[] = [];
const ownedPosts: FixtureRow[] = [];
const ownedReactions: FixtureRow[] = [];
let authorId: string;
let viewerId: string;
let oldPostId: string;
let recentPostId: string;
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
  // The widget reads a window anchored to the server clock. Place the
  // fixture before every existing row so the window contains only these
  // posts, without deleting or modifying rows owned by other suites.
  const [bounds] = await dbWrite
    .select({ oldest: sql<string | null>`min(${posts.timestamp})::text` })
    .from(posts);
  const oldest = bounds?.oldest
    ? new Date(bounds.oldest).getTime()
    : Date.now();
  fixtureTime = new Date(Math.min(Date.now(), oldest) - 48 * 60 * 60 * 1000);

  const authorIds = await Promise.all(
    Array.from({ length: 1 }, () => generateSnowflakeId())
  );
  authorId = authorIds[0]!;

  const likerIds = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  viewerId = likerIds[0]!;
  const now = fixtureTime;
  const insertedUsers = await dbWrite
    .insert(users)
    .values([
      {
        id: authorId,
        username: `tpt${authorId}`,
        displayName: 'Trending timeframe fixture author',
        isTest: false,
        updatedAt: now,
      },
      ...likerIds.map((id) => ({
        id,
        username: `tpt${id}`,
        displayName: 'Trending timeframe liker fixture',
        isTest: false,
        updatedAt: now,
        stewardId: id === viewerId ? `trending-${viewerId}` : null,
      })),
    ])
    .returning({ id: users.id, version: rowVersion });
  ownedUsers.push(...insertedUsers);

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
    Array.from({ length: 2 }, () => generateSnowflakeId())
  );
  oldPostId = postIdsGenerated[0]!;
  recentPostId = postIdsGenerated[1]!;
  const oldTime = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const recentTime = new Date(now.getTime() - 30 * 60 * 1000);
  const insertedPosts = await dbWrite
    .insert(posts)
    .values([
      {
        id: oldPostId,
        content: 'Trending timeframe fixture: 3 days old',
        authorId,
        timestamp: oldTime,
        createdAt: oldTime,
      },
      {
        id: recentPostId,
        content: 'Trending timeframe fixture: 30 minutes old',
        authorId,
        timestamp: recentTime,
        createdAt: recentTime,
      },
    ])
    .returning({ id: posts.id, version: rowVersion });
  ownedPosts.push(...insertedPosts);

  // 5 likes each: same engagement, only the age differs, so any
  // difference in the result comes from the time window alone.
  const likes = await Promise.all(
    [oldPostId, recentPostId].flatMap((postId) =>
      likerIds.slice(0, 5).map(async (userId) => ({
        id: await generateSnowflakeId(),
        postId,
        userId,
        type: 'like' as const,
      }))
    )
  );
  const insertedReactions = await dbWrite
    .insert(reactions)
    .values(likes)
    .returning({ id: reactions.id, version: rowVersion });
  ownedReactions.push(...insertedReactions);
});

async function cleanFixtures(
  userRows: FixtureRow[],
  postRows: FixtureRow[],
  reactionRows: FixtureRow[]
) {
  await dbWrite.transaction(async (tx) => {
    const userIds = userRows.map(({ id }) => id);
    if (userIds.length) {
      // Hold parent locks so Postgres cannot attach another FK row after the
      // check. Plain NO ACTION / RESTRICT children already prevent deletion.
      const locked = await tx
        .select({ id: users.id, version: rowVersion })
        .from(users)
        .where(inArray(users.id, userIds))
        .for('update');
      if (
        locked.length !== userRows.length ||
        locked.some(
          (row) =>
            !userRows.some(
              ({ id, version }) => id === row.id && version === row.version
            )
        )
      ) {
        throw new Error('Trending fixture user changed before cleanup');
      }
      const [foreign] = await tx.execute<{ found: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM ${gameOnboarding} WHERE ${inArray(gameOnboarding.userId, userIds)}
          UNION ALL SELECT 1 FROM ${userPnLSnapshots} WHERE ${inArray(userPnLSnapshots.userId, userIds)}
          UNION ALL SELECT 1 FROM ${whitelist} WHERE ${or(inArray(whitelist.userId, userIds), inArray(whitelist.grantedBy, userIds))}
          UNION ALL SELECT 1 FROM ${whitelistConfig} WHERE ${inArray(whitelistConfig.updatedBy, userIds)}
        ) AS found
      `);
      if (foreign?.found !== false) {
        throw new Error('Trending fixture user has a foreign reference');
      }
    }
    for (const [table, rows] of [
      [reactions, reactionRows],
      [posts, postRows],
      [users, userRows],
    ] as const) {
      if (rows.length === 0) continue;
      const deleted = await tx
        .delete(table)
        .where(
          inArray(
            table.id,
            rows.map(({ id }) => id)
          )
        )
        .returning({ id: table.id, version: rowVersion });
      if (
        deleted.length !== rows.length ||
        deleted.some(
          (row) =>
            !rows.some(
              ({ id, version }) => id === row.id && version === row.version
            )
        )
      ) {
        throw new Error('Trending fixture row changed before cleanup');
      }
    }
  });
}

afterAll(() => cleanFixtures(ownedUsers, ownedPosts, ownedReactions));

async function fetchTrending(
  signedIn: boolean,
  query?: string
): Promise<TrendingPost[]> {
  const request = new NextRequest(
    `http://localhost/api/feed/widgets/trending-posts${query ?? ''}`,
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

describe('Trending posts widget honors timeframe', () => {
  for (const signedIn of [false, true]) {
    const mode = signedIn ? 'signed-in' : 'public';
    it(`includes a 3-day-old post for timeframe=7d (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?timeframe=7d');
      const ids = result.map((post) => post.id);
      expect(ids).toContain(oldPostId);
      expect(ids).toContain(recentPostId);
      const old = result.find((post) => post.id === oldPostId);
      expect(old?.likeCount).toBe(5);
    });
    it(`excludes a 3-day-old post for timeframe=24h (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?timeframe=24h');
      expect(result.map((post) => post.id)).toEqual([recentPostId]);
    });
    it(`excludes a 3-day-old post for timeframe=6h (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?timeframe=6h');
      expect(result.map((post) => post.id)).toEqual([recentPostId]);
    });
    it(`keeps a 30-minute-old post for timeframe=1h (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?timeframe=1h');
      expect(result.map((post) => post.id)).toEqual([recentPostId]);
    });
    it(`defaults to the 24h window without timeframe (${mode})`, async () => {
      const result = await fetchTrending(signedIn);
      expect(result.map((post) => post.id)).toEqual([recentPostId]);
    });
  }
});

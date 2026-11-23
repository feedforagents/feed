/**
 * The trending-posts widget must honor the `minInteractions` query
 * parameter: a post with fewer than `minInteractions` total interactions
 * (likes + comments + shares) must not appear in the trending list.
 *
 * Basis: the route's own OpenAPI doc (`minInteractions`, "Minimum
 * interactions required", default `5`) + `TrendingPostsQuerySchema`
 * (`packages/shared/src/validation/schemas/game.ts:190`,
 * `z.coerce.number().int().nonnegative().default(5)`) + merged precedent
 * 6900e85dc (SYMBaiEX, "fix: honor upcoming event timeframes"), which
 * fixed the same "parse the parameter but never apply it" defect in the
 * sibling upcoming-events widget. Uses the real route and PostgreSQL.
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
  comments,
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
const ownedComments: FixtureRow[] = [];
let authorId: string;
let viewerId: string;
let lowPostId: string;
let highPostId: string;
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
        username: `tpm${authorId}`,
        displayName: 'Trending min-interactions fixture author',
        isTest: false,
        updatedAt: now,
      },
      ...likerIds.map((id) => ({
        id,
        username: `tpm${id}`,
        displayName: 'Trending min-interactions liker fixture',
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
  lowPostId = postIdsGenerated[0]!;
  highPostId = postIdsGenerated[1]!;
  // 30 minutes old at the fixture clock: inside the 24h window, with the
  // same recency factor for both posts so ranking follows engagement.
  const postTime = new Date(now.getTime() - 30 * 60 * 1000);
  const insertedPosts = await dbWrite
    .insert(posts)
    .values([
      {
        id: lowPostId,
        content: 'Trending min-interactions fixture: 2 likes',
        authorId,
        timestamp: postTime,
        createdAt: postTime,
      },
      {
        id: highPostId,
        content: 'Trending min-interactions fixture: 3 likes, 3 comments',
        authorId,
        timestamp: postTime,
        createdAt: postTime,
      },
    ])
    .returning({ id: posts.id, version: rowVersion });
  ownedPosts.push(...insertedPosts);

  // Low post: 2 interactions. High post: 3 likes + 3 comments = 6.
  const engagement: Array<[string, number]> = [
    [lowPostId, 2],
    [highPostId, 3],
  ];
  const likes = await Promise.all(
    engagement.flatMap(([postId, count]) =>
      likerIds.slice(0, count).map(async (userId) => ({
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

  const commentRows = await Promise.all(
    likerIds.slice(0, 3).map(async (userId) => ({
      id: await generateSnowflakeId(),
      content: 'Trending min-interactions fixture comment',
      postId: highPostId,
      authorId: userId,
      createdAt: postTime,
      updatedAt: postTime,
      deletedAt: null,
    }))
  );
  const insertedComments = await dbWrite
    .insert(comments)
    .values(commentRows)
    .returning({ id: comments.id, version: rowVersion });
  ownedComments.push(...insertedComments);
});

async function cleanFixtures(
  userRows: FixtureRow[],
  postRows: FixtureRow[],
  reactionRows: FixtureRow[],
  commentRows: FixtureRow[]
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
      [comments, commentRows],
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

afterAll(() =>
  cleanFixtures(ownedUsers, ownedPosts, ownedReactions, ownedComments)
);

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

describe('Trending posts widget honors minInteractions', () => {
  for (const signedIn of [false, true]) {
    const mode = signedIn ? 'signed-in' : 'public';
    it(`applies the default threshold of 5 (${mode})`, async () => {
      const result = await fetchTrending(signedIn);
      expect(result.map((post) => post.id)).toEqual([highPostId]);
    });
    it(`excludes both posts above the highest fixture total (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?minInteractions=10');
      expect(result.map((post) => post.id)).toEqual([]);
    });
    it(`includes both posts at a threshold of 1 (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?minInteractions=1');
      expect(result.map((post) => post.id)).toEqual([highPostId, lowPostId]);
      const low = result.find((post) => post.id === lowPostId);
      expect(low?.likeCount).toBe(2);
      expect(low?.commentCount).toBe(0);
      const high = result.find((post) => post.id === highPostId);
      expect(high?.likeCount).toBe(3);
      expect(high?.commentCount).toBe(3);
    });
    it(`keeps only the 6-interaction post at the boundary (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?minInteractions=6');
      expect(result.map((post) => post.id)).toEqual([highPostId]);
    });
  }
});

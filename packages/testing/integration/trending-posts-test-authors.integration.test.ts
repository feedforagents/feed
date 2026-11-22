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
import {
  dbWrite,
  eq,
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
  const [bounds] = await dbWrite
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
  const insertedUsers = await dbWrite
    .insert(users)
    .values([
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
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  normalPostId = postIdsGenerated[0]!;
  noUserPostId = postIdsGenerated[1]!;
  testFlagPostId = postIdsGenerated[2]!;
  prefixPostId = postIdsGenerated[3]!;
  deletedPostId = postIdsGenerated[4]!;
  futurePostId = postIdsGenerated[5]!;
  const insertedPosts = await dbWrite
    .insert(posts)
    .values([
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
    ])
    .returning({ id: posts.id, version: rowVersion });
  ownedPosts.push(...insertedPosts);

  // Enough engagement that the excluded posts would outrank the visible
  // ones if the author filter were missing.
  const engagement: Array<[string, number]> = [
    [normalPostId, 3],
    [noUserPostId, 4],
    [testFlagPostId, 6],
    [prefixPostId, 5],
    [deletedPostId, 2],
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
    it(`honors the requested limit after ranking visible posts (${mode})`, async () => {
      const result = await fetchTrending(signedIn, '?limit=1');
      expect(result.map((post) => post.id)).toEqual([noUserPostId]);
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

  it('refuses to delete fixture rows while an unrelated onboarding row references them', async () => {
    const [onboarding] = await dbWrite
      .insert(gameOnboarding)
      .values({
        id: await generateSnowflakeId(),
        userId: viewerId,
      })
      .returning({ id: gameOnboarding.id });
    if (!onboarding)
      throw new Error('Onboarding control insert returned no row');
    try {
      await expect(
        cleanFixtures(ownedUsers, ownedPosts, ownedReactions)
      ).rejects.toThrow('Trending fixture user has a foreign reference');
      const [retained] = await dbWrite
        .select({ id: gameOnboarding.id })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, onboarding.id));
      expect(retained?.id).toBe(onboarding.id);
      const [post] = await dbWrite
        .select({ id: posts.id })
        .from(posts)
        .where(eq(posts.id, normalPostId));
      expect(post?.id).toBe(normalPostId);
    } finally {
      await dbWrite
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, onboarding.id));
    }
  });
});

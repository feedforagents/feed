/** Recent and Following repost visibility before pagination. PRD §12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  recent: 'fills recent, actor and type pages without excluded reposts',
  following:
    'fills Following pages and retains quote commentary through the cursor walk',
  public: 'keeps visible originals for anonymous and unaffected viewers',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks main feed moderation on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'feed-repost-original-moderation',
      file: 'packages/testing/integration/feed-repost-original-moderation.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { CACHE_KEYS, getCache, optionalAuth, setCache } = await import(
    '@feed/api'
  );
  const {
    comments,
    dbWrite,
    desc,
    follows,
    inArray,
    posts,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET } = await import('../../../apps/web/src/app/api/posts/route');
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();
  const older = new Date(now.getTime() - 3_600_000);

  async function seedUser(role: string) {
    const id = await generateSnowflakeId();
    const stewardId = `feed-repost-${role}`;
    await dbWrite.insert(users).values({
      id,
      username: stewardId,
      stewardId,
      updatedAt: now,
    });
    return { id, stewardId };
  }

  const owner = await seedUser('owner');
  const viewer = await seedUser('viewer');
  const normal = await seedUser('normal');
  const blocked = await seedUser('blocked');
  const muted = await seedUser('muted');
  const blocking = await seedUser('blocking');

  const originals = [
    { id: 'normal-original', authorId: normal.id },
    { id: 'blocked-original', authorId: blocked.id },
    { id: 'muted-original', authorId: muted.id },
    { id: 'blocking-original', authorId: blocking.id },
  ];
  const postsFromOwner = [
    { id: 'first-post', content: 'Visible first page' },
    { id: 'blocked-repost', content: '', originalPostId: 'blocked-original' },
    { id: 'second-post', content: 'Visible second page' },
    { id: 'muted-repost', content: '', originalPostId: 'muted-original' },
    { id: 'third-post', content: 'Visible third page' },
    { id: 'blocking-repost', content: '', originalPostId: 'blocking-original' },
    {
      id: 'blocked-quote',
      content: 'Visible quote commentary',
      originalPostId: 'blocked-original',
    },
    { id: 'normal-repost', content: '', originalPostId: 'normal-original' },
  ];
  await dbWrite.transaction(async (tx) => {
    await tx.insert(follows).values({
      id: 'viewer-follows-owner',
      followerId: viewer.id,
      followingId: owner.id,
    });
    await tx.insert(userBlocks).values([
      { id: 'outgoing', blockerId: viewer.id, blockedId: blocked.id },
      { id: 'incoming', blockerId: blocking.id, blockedId: viewer.id },
    ]);
    await tx
      .insert(userMutes)
      .values({ id: 'mute', muterId: viewer.id, mutedId: muted.id });
    await tx.insert(posts).values([
      ...originals.map((row, index) => ({
        ...row,
        content: `Fixture original ${row.id}`,
        timestamp: new Date(older.getTime() - index * 1000),
      })),
      ...postsFromOwner.map((row, index) => ({
        ...row,
        authorId: owner.id,
        timestamp: new Date(now.getTime() - (index + 1) * 1000),
      })),
    ]);
    const comment = {
      postId: 'second-post',
      authorId: normal.id,
      content: 'Fixture comment',
      updatedAt: now,
    };
    await tx.insert(comments).values([
      { ...comment, id: 'live-comment' },
      { ...comment, id: 'deleted-comment', deletedAt: now },
    ]);
  });

  // A deployment may retain pages selected under the old moderation rules.
  // Warm both prior cache keys with real fixture rows before checking the new pages.
  const oldPage = await dbWrite
    .select()
    .from(posts)
    .where(inArray(posts.id, ['first-post', 'blocked-repost']))
    .orderBy(desc(posts.timestamp));
  const excluded = [blocked.id, muted.id, blocking.id].sort();
  const oldRecentKey = JSON.stringify([
    'post-visibility-v1',
    null,
    2,
    'offset',
    0,
    excluded,
    true,
  ]);
  const oldFollowingKey = `${viewer.id}:2:offset:0:excl:${excluded.join(',')}`;
  for (const [key, namespace] of [
    [oldRecentKey, CACHE_KEYS.POSTS_LIST],
    [oldFollowingKey, CACHE_KEYS.POSTS_FOLLOWING],
  ] as const) {
    await setCache(key, oldPage, { namespace, ttl: 60 });
    expect(await getCache(key, { namespace })).toHaveLength(2);
  }

  type FeedPage = {
    posts: {
      id: string;
      content: string;
      commentCount?: number;
      originalPost?: { id: string; authorId: string } | null;
    }[];
    source?: string;
    cursor?: string | null;
    hasMore?: boolean;
    nextCursor?: string | null;
  };

  async function feed(
    user: typeof viewer | null,
    query: Record<string, string>
  ) {
    const url = new URL('http://localhost/api/posts');
    url.search = new URLSearchParams(query).toString();
    const headers = new Headers();
    if (user) {
      headers.set(
        'authorization',
        `Bearer ${await createStewardTestToken(user.stewardId)}`
      );
    }
    const request = new NextRequest(url, { headers });
    expect((await optionalAuth(request))?.userId ?? null).toBe(
      user?.id ?? null
    );
    const response = await GET(request);
    expect(response.status).toBe(200);
    return (await response.json()) as FeedPage;
  }

  const ownerFeed = [
    'first-post',
    'second-post',
    'third-post',
    'blocked-quote',
    'normal-repost',
  ];

  async function walk(query: Record<string, string>, expected: string[]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page <= expected.length; page++) {
      const response = await feed(viewer, {
        ...query,
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...response.posts.map(({ id }) => id));
      cursor =
        response.source === 'following'
          ? (response.nextCursor ?? null)
          : response.hasMore
            ? (response.cursor ?? null)
            : null;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected);
  }

  test(cases.recent, async () => {
    const selectors: Record<string, string>[] = [
      {},
      { actorId: owner.id },
      { type: 'post' },
    ];
    for (const filters of selectors) {
      const first = await feed(viewer, { ...filters, limit: '2' });
      expect(first.posts.map(({ id }) => id)).toEqual(ownerFeed.slice(0, 2));
      expect(first.hasMore).toBe(true);
    }
    await walk({}, [...ownerFeed, 'normal-original']);
    const full = await feed(viewer, { limit: '10' });
    expect(full.posts.find(({ id }) => id === 'blocked-quote')).toMatchObject({
      content: 'Visible quote commentary',
      originalPost: null,
    });
  });

  test(cases.following, async () => {
    const filters = { following: 'true', userId: viewer.id };
    const first = await feed(viewer, { ...filters, limit: '2' });
    expect(first.source).toBe('following');
    expect(first.posts.map(({ id }) => id)).toEqual(ownerFeed.slice(0, 2));
    expect(first.posts[1]?.commentCount).toBe(1);
    expect(first.nextCursor).toBeTruthy();
    await walk(filters, ownerFeed);
    const full = await feed(viewer, { ...filters, limit: '10' });
    const quote = full.posts.find(({ id }) => id === 'blocked-quote');
    expect(quote?.content).toBe('Visible quote commentary');
    expect(quote?.originalPost).toBeUndefined();
    expect(
      full.posts.find(({ id }) => id === 'normal-repost')?.originalPost
    ).toMatchObject({ id: 'normal-original', authorId: normal.id });
  });

  test(cases.public, async () => {
    for (const user of [null, normal]) {
      const first = await feed(user, { limit: '2' });
      expect(first.posts.map(({ id }) => id)).toEqual([
        'first-post',
        'blocked-repost',
      ]);
      expect(first.posts[1]?.originalPost).toMatchObject({
        id: 'blocked-original',
        authorId: blocked.id,
      });
    }
  });
}

/** Trending discovery honors viewer blocks and mutes. PRD §12, MVP Phase 5. */
import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  moderation:
    'applies blocks and mutes to direct posts and their reposts and quotes',
  candidateWindow:
    'applies viewer moderation before the candidate and response limits',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks trending widget moderation on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'trending-posts-viewer-moderation',
      file: 'packages/testing/integration/trending-posts-viewer-moderation.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();

  const { optionalAuth } = await import('@feed/api');
  const { comments, dbWrite, posts, reactions, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET } = await import(
    '../../../apps/web/src/app/api/feed/widgets/trending-posts/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();
  const recent = now.getTime() - 60_000;
  const old = new Date(now.getTime() - 26 * 60 * 60 * 1000);

  async function seedUser(label: string, isTest = false) {
    const id = await generateSnowflakeId();
    const stewardId = `trending-moderation-${label}`;
    await dbWrite.insert(users).values({
      id,
      stewardId,
      username: stewardId,
      isTest,
      updatedAt: now,
    });
    return { id, stewardId };
  }

  const viewer = await seedUser('viewer');
  const normal = await seedUser('normal');
  const blocked = await seedUser('blocked');
  const muted = await seedUser('muted');
  const blockedBy = await seedUser('blocked-by');
  const fixtureAuthor = await seedUser('hidden-fixture', true);

  await dbWrite.insert(userBlocks).values([
    { id: 'outgoing', blockerId: viewer.id, blockedId: blocked.id },
    { id: 'incoming', blockerId: blockedBy.id, blockedId: viewer.id },
  ]);
  await dbWrite.insert(userMutes).values({
    id: 'mute',
    muterId: viewer.id,
    mutedId: muted.id,
  });

  const hidden = [
    { id: 'blocked-post', authorId: blocked.id, content: 'Blocked post' },
    { id: 'muted-post', authorId: muted.id, content: 'Muted post' },
    { id: 'blocking-post', authorId: blockedBy.id, content: 'Blocking author' },
    {
      id: 'blocked-original-repost',
      authorId: normal.id,
      content: '',
      originalPostId: 'old-blocked-post',
    },
    {
      id: 'muted-original-quote',
      authorId: normal.id,
      content: 'Quote of a muted author',
      originalPostId: 'old-muted-post',
    },
  ];
  await dbWrite.insert(posts).values([
    ...hidden.map((row, index) => ({
      ...row,
      timestamp: new Date(recent - index * 1000),
    })),
    {
      id: 'old-blocked-post',
      authorId: blocked.id,
      content: 'Old blocked original',
      timestamp: old,
    },
    {
      id: 'old-muted-post',
      authorId: muted.id,
      content: 'Old muted original',
      timestamp: old,
    },
    {
      id: 'old-visible-post',
      authorId: normal.id,
      content: 'Old allowed original',
      timestamp: old,
    },
    {
      id: 'visible-post',
      authorId: normal.id,
      content: 'Allowed post',
      timestamp: new Date(recent - 10_000),
    },
    {
      id: 'visible-original-quote',
      authorId: normal.id,
      content: 'Quote of an allowed author',
      originalPostId: 'old-visible-post',
      timestamp: new Date(recent - 11_000),
    },
    {
      id: 'fixture-post',
      authorId: fixtureAuthor.id,
      content: 'Test author post',
      timestamp: new Date(recent + 1_000),
    },
  ]);
  await dbWrite.insert(reactions).values([
    ...[...hidden.map((row) => row.id), 'fixture-post'].flatMap((postId) =>
      [viewer.id, normal.id, blocked.id].map((userId) => ({
        id: `like-${postId}-${userId}`,
        postId,
        userId,
      }))
    ),
    ...['visible-post', 'visible-original-quote'].map((postId) => ({
      id: `like-${postId}`,
      postId,
      userId: viewer.id,
    })),
  ]);
  const comment = {
    content: 'Widget counting fixture',
    postId: 'visible-post',
    authorId: normal.id,
    updatedAt: now,
  };
  await dbWrite.insert(comments).values([
    { ...comment, id: 'visible-comment' },
    { ...comment, id: 'deleted-comment', deletedAt: now },
  ]);

  async function trending(user?: typeof viewer, limit?: number) {
    const url = new URL('http://localhost/api/feed/widgets/trending-posts');
    if (limit !== undefined) url.searchParams.set('limit', String(limit));
    const headers = new Headers();
    if (user) {
      headers.set(
        'authorization',
        `Bearer ${await createStewardTestToken(user.stewardId)}`
      );
    }
    const request = new NextRequest(url, { headers });
    if (user) expect((await optionalAuth(request))?.userId).toBe(user.id);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      posts: { id: string; likeCount: number; commentCount: number }[];
    };
    return payload.posts;
  }

  test(cases.moderation, async () => {
    const originalIds = hidden.map(({ id }) => id);
    expect((await trending()).map(({ id }) => id)).toEqual(originalIds);
    expect((await trending(normal)).map(({ id }) => id)).toEqual(originalIds);

    expect(await trending(viewer)).toMatchObject([
      { id: 'visible-post', likeCount: 1, commentCount: 1 },
      { id: 'visible-original-quote', likeCount: 1, commentCount: 0 },
    ]);
  });

  test(cases.candidateWindow, async () => {
    await dbWrite.insert(posts).values(
      Array.from({ length: 105 }, (_, index) => ({
        id: `new-muted-${index}`,
        authorId: muted.id,
        content: `Muted candidate ${index}`,
        timestamp: new Date(recent + 2_000 + index),
      }))
    );

    expect((await trending(viewer, 1)).map(({ id }) => id)).toEqual([
      'visible-post',
    ]);
  });
}

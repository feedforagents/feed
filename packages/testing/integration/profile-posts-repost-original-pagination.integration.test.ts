/** Profile repost visibility before pagination. PRD §12, MVP Phase 5. */
import { expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  paging: 'fills profile pages with visible reposts, quotes and original posts',
  moderation: 'preserves quote commentary while hiding excluded originals',
  public: 'preserves public and unaffected viewer reposts and quotes',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks profile repost pagination on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'profile-repost-pagination',
      file: 'packages/testing/integration/profile-posts-repost-original-pagination.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();

  const { optionalAuth } = await import('@feed/api');
  const { dbWrite, posts, users, userBlocks, userMutes } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  );
  const { createStewardTestToken } = await import('./helpers/steward-auth');

  const now = new Date();

  async function seedUser(label: string) {
    const id = await generateSnowflakeId();
    const stewardId = `profile-repost-${label}`;
    await dbWrite.insert(users).values({
      id,
      username: stewardId,
      displayName: label,
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

  const after = new Date(now.getTime() + 3_600_000);
  const before = new Date(now.getTime() - 3_600_000);
  const originals = [
    {
      id: 'normal-original',
      authorId: normal.id,
      content: 'Visible original',
      timestamp: before,
    },
    {
      id: 'blocked-original',
      authorId: blocked.id,
      content: 'Blocked original',
      timestamp: before,
    },
    {
      id: 'muted-original',
      authorId: muted.id,
      content: 'Muted original',
      timestamp: before,
    },
    {
      id: 'blocking-original',
      authorId: blocking.id,
      content: 'Blocking original',
      timestamp: before,
    },
    {
      id: 'future-original',
      authorId: normal.id,
      content: 'Future original',
      timestamp: after,
    },
    {
      id: 'deleted-original',
      authorId: normal.id,
      content: 'Deleted original',
      timestamp: before,
      deletedAt: now,
    },
  ];

  const profile = [
    { id: 'own-first', content: 'First post' },
    { id: 'repost-blocked', content: '', originalPostId: 'blocked-original' },
    { id: 'own-second', content: 'Second post' },
    { id: 'repost-blocking', content: '', originalPostId: 'blocking-original' },
    { id: 'own-third', content: 'Third post' },
    {
      id: 'quote-muted',
      content: 'Commentary on a muted author',
      originalPostId: 'muted-original',
    },
    { id: 'own-fourth', content: 'Fourth post' },
    { id: 'repost-normal', content: '', originalPostId: 'normal-original' },
    {
      id: 'quote-blocking',
      content: 'Commentary on a blocking author',
      originalPostId: 'blocking-original',
    },
    {
      id: 'quote-normal',
      content: 'Commentary on an allowed author',
      originalPostId: 'normal-original',
    },
    { id: 'repost-muted', content: '', originalPostId: 'muted-original' },
    { id: 'repost-future', content: '', originalPostId: 'future-original' },
    { id: 'repost-deleted', content: '', originalPostId: 'deleted-original' },
    {
      id: 'quote-deleted',
      content: 'Commentary on a deleted original',
      originalPostId: 'deleted-original',
    },
  ];

  await dbWrite.transaction(async (tx) => {
    await tx.insert(userBlocks).values([
      { id: 'viewer-outgoing', blockerId: viewer.id, blockedId: blocked.id },
      { id: 'viewer-incoming', blockerId: blocking.id, blockedId: viewer.id },
    ]);
    await tx.insert(userMutes).values({
      id: 'viewer-mute',
      muterId: viewer.id,
      mutedId: muted.id,
    });
    await tx.insert(posts).values([
      ...originals,
      ...profile.map((post, index) => ({
        ...post,
        authorId: owner.id,
        timestamp: new Date(now.getTime() - (index + 1) * 10_000),
      })),
    ]);
  });

  async function profilePosts(
    user: typeof viewer | null,
    page: number,
    limit: number
  ) {
    const headers = new Headers();
    if (user) {
      headers.set(
        'authorization',
        `Bearer ${await createStewardTestToken(user.stewardId)}`
      );
    }
    const request = new NextRequest(
      `http://localhost/api/users/${owner.id}/posts?type=posts&page=${page}&limit=${limit}`,
      { headers }
    );
    expect((await optionalAuth(request))?.userId ?? null).toBe(
      user?.id ?? null
    );
    const response = await GET(request, {
      params: Promise.resolve({ userId: owner.id }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      type: string;
      items: {
        id: string;
        content: string;
        quoteComment?: string;
        originalPost?: { id: string; authorId: string; content: string } | null;
      }[];
      total: number;
    };
  }

  const signedPages = [
    ['own-first', 'own-second'],
    ['own-third', 'quote-muted'],
    ['own-fourth', 'repost-normal'],
    ['quote-blocking', 'quote-normal'],
    ['quote-deleted'],
  ];

  test(cases.paging, async () => {
    for (const [index, expected] of signedPages.entries()) {
      const result = await profilePosts(viewer, index + 1, 2);
      expect(result.type).toBe('posts');
      expect(result.items.map(({ id }) => id)).toEqual(expected);
      expect(result.total).toBe(expected.length);
    }
    const walked: string[] = [];
    const expected = signedPages.flat();
    for (let page = 1; page <= expected.length + 1; page++) {
      const result = await profilePosts(viewer, page, 1);
      walked.push(...result.items.map(({ id }) => id));
    }
    expect(walked).toEqual(expected);
  });

  test(cases.moderation, async () => {
    const result = await profilePosts(viewer, 1, 20);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect([...byId.keys()]).toEqual(signedPages.flat());
    expect(byId.get('quote-muted')).toMatchObject({
      quoteComment: 'Commentary on a muted author',
      originalPost: null,
    });
    expect(byId.get('quote-blocking')).toMatchObject({
      quoteComment: 'Commentary on a blocking author',
      originalPost: null,
    });
    expect(byId.get('quote-deleted')?.originalPost).toBeNull();
    for (const id of ['repost-normal', 'quote-normal']) {
      expect(byId.get(id)?.originalPost).toMatchObject({
        id: 'normal-original',
        authorId: normal.id,
        content: 'Visible original',
      });
    }
  });

  test(cases.public, async () => {
    const anonymous = await profilePosts(null, 1, 20);
    const unrelated = await profilePosts(normal, 1, 20);
    const publicIds = profile
      .map(({ id }) => id)
      .filter((id) => id !== 'repost-future' && id !== 'repost-deleted');
    expect(anonymous.items.map(({ id }) => id)).toEqual(publicIds);
    expect(unrelated.items.map(({ id }) => id)).toEqual(publicIds);
    for (const result of [anonymous, unrelated]) {
      expect(
        result.items.find(({ id }) => id === 'repost-blocked')?.originalPost
      ).toMatchObject({ id: 'blocked-original', authorId: blocked.id });
      expect(
        result.items.find(({ id }) => id === 'quote-muted')?.originalPost
      ).toMatchObject({ id: 'muted-original', authorId: muted.id });
    }
  });
}

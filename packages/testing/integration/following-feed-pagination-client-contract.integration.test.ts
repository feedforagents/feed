/** Signed Following cursor contract over PostgreSQL. PRD §§8.2, 12, MVP Phase 5. */
import { expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  walk: 'reaches all 25 followed posts across two pages with no overlap',
  end: 'reports hasMore true on page 1 and false with a null cursor on page 2',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks the Following cursor contract on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'following-feed-pagination-client-contract',
      file: 'packages/testing/integration/following-feed-pagination-client-contract.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  mock.module('server-only', () => ({}));
  const { dbWrite: db, follows, posts, users } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  type PostsResponse = {
    success: boolean;
    posts: Array<{ id: string; timestamp: string }>;
    source?: string;
    nextCursor?: string | null;
    hasMore?: boolean;
  };

  let viewerId: string;
  let authorId: string;
  let token: string;
  const postIds: string[] = [];

  let GET: (request: NextRequest) => Promise<Response>;
  const routePath = '../../../apps/web/src/app/api/posts/route';

  async function fetchFollowingFeed(query: string) {
    const request = new NextRequest(
      new Request(`http://localhost/api/posts?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    const response = await GET(request);
    const body = (await response.json().catch(() => null)) as
      | PostsResponse
      | { error?: unknown }
      | null;
    return { status: response.status, body };
  }

  {
    ({ GET } = await import(routePath));

    [viewerId, authorId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    for (let i = 0; i < 25; i++) postIds.push(await generateSnowflakeId());

    token = await createStewardTestToken(`following-${viewerId}`);

    const now = new Date();
    const base = new Date(now.getTime() - 120_000);
    const earlier = new Date(now.getTime() - 180_000);

    await db.insert(users).values([
      {
        id: viewerId,
        username: `f4v-${viewerId}`,
        displayName: 'Following Pagination Viewer',
        stewardId: `following-${viewerId}`,
        updatedAt: now,
      },
      {
        id: authorId,
        username: `f4a-${authorId}`,
        displayName: 'Following Pagination Author',
        updatedAt: now,
      },
    ]);

    await db.insert(follows).values({
      id: await generateSnowflakeId(),
      followerId: viewerId,
      followingId: authorId,
      createdAt: earlier,
    });

    // 25 posts, newest first, one second apart so page order is deterministic.
    await db.insert(posts).values(
      postIds.map((id, i) => {
        const ts = new Date(base.getTime() - i * 1000);
        return {
          id,
          content: `following pagination fixture post ${i}`,
          authorId,
          timestamp: ts,
          createdAt: ts,
        };
      })
    );
  }

  test(cases.walk, async () => {
    const first = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20`
    );
    expect(first.status).toBe(200);
    const firstBody = first.body as PostsResponse;
    expect(firstBody.source).toBe('following');
    expect(firstBody.posts).toHaveLength(20);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    );
    expect(second.status).toBe(200);
    const secondBody = second.body as PostsResponse;
    expect(secondBody.posts).toHaveLength(5);

    const seen = new Set([
      ...firstBody.posts.map((p) => p.id),
      ...secondBody.posts.map((p) => p.id),
    ]);
    expect(seen.size).toBe(25);
    expect([...seen].sort()).toEqual([...postIds].sort());
  });

  test(cases.end, async () => {
    const first = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20`
    );
    const firstBody = first.body as PostsResponse;
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await fetchFollowingFeed(
      `following=true&userId=${viewerId}&limit=20&cursor=${encodeURIComponent(firstBody.nextCursor!)}`
    );
    const secondBody = second.body as PostsResponse;
    expect(secondBody.hasMore).toBe(false);
    expect(secondBody.nextCursor).toBeNull();
  });
}

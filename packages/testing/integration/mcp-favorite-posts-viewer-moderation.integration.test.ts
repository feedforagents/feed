/** PRD §§8.1, 12 / MVP Phases 3 and 5: honor moderation on the retained MCP favorites list. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP get_favorite_posts viewer moderation';
const cases = {
  viewer: 'applies blocks and mutes before paging favorites',
  stranger: 'shows all favorited authors to an unrelated viewer',
  http: 'applies the same paging over authenticated MCP HTTP',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP favorites in a leased PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-favorite-posts-viewer-moderation',
      file: 'packages/testing/integration/mcp-favorite-posts-viewer-moderation.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const {
    dbWrite,
    favorites,
    posts,
    userApiKeys,
    userBlocks,
    userMutes,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');
  const { executeGetFavoritePosts } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const [viewerId, strangerId, blockedId, mutedId, blockerId, visibleId] =
    await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
  const authors = [blockedId, mutedId, blockerId, visibleId];
  const now = new Date();
  const fixturePosts = await Promise.all(
    [...authors, visibleId].map(async (authorId, index) => ({
      id: await generateSnowflakeId(),
      authorId,
      content: 'Favorites moderation fixture',
      timestamp: new Date(now.getTime() - (index + 1) * 60_000),
    }))
  );
  const visiblePostIds = fixturePosts
    .filter((post) => post.authorId === visibleId)
    .map((post) => post.id);
  const apiKey = generateApiKey();
  const keyId = await generateSnowflakeId();
  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values(
      [viewerId, strangerId, ...authors].map((id) => ({
        id,
        username: `favorites-${id}`,
        updatedAt: now,
      }))
    );
    await tx.insert(posts).values(fixturePosts);
    await tx.insert(favorites).values(
      [viewerId, strangerId].flatMap((userId) =>
        authors.map((targetUserId) => ({
          id: crypto.randomUUID(),
          userId,
          targetUserId,
          createdAt: now,
        }))
      )
    );
    await tx.insert(userBlocks).values([
      { id: crypto.randomUUID(), blockerId: viewerId, blockedId },
      { id: crypto.randomUUID(), blockerId, blockedId: viewerId },
    ]);
    await tx.insert(userMutes).values({
      id: crypto.randomUUID(),
      muterId: viewerId,
      mutedId,
    });
    await tx.insert(userApiKeys).values({
      id: keyId,
      userId: viewerId,
      keyHash: hashApiKey(apiKey),
      name: 'Favorites fixture',
    });
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const headers = new Headers(request.headers);
      // Select the per-user key flow instead of the loopback dev bypass.
      headers.set('host', 'favorites-moderation.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));

  describe(suite, () => {
    test(cases.viewer, async () => {
      const agent = { agentId: 'agent', userId: viewerId };
      const full = await executeGetFavoritePosts(agent, { limit: 20 });
      expect(full.posts.map((post) => post.id)).toEqual(visiblePostIds);
      const first = await executeGetFavoritePosts(agent, { limit: 1 });
      expect(first.posts.map((post) => post.id)).toEqual(
        visiblePostIds.slice(0, 1)
      );
    });

    test(cases.stranger, async () => {
      const result = await executeGetFavoritePosts(
        { agentId: 'agent', userId: strangerId },
        { limit: 20 }
      );
      expect(result.posts.map((post) => post.id)).toEqual(
        fixturePosts.map((post) => post.id)
      );
    });

    test(cases.http, async () => {
      const endpoint = new URL('/api/mcp', server.url);
      const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_favorite_posts',
            arguments: { limit: 1, offset: 1 },
          },
        }),
      };
      expect((await fetch(endpoint, request)).status).toBe(401);
      const response = await fetch(endpoint, {
        ...request,
        headers: { ...request.headers, 'X-Feed-Api-Key': apiKey },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: { content?: Array<{ text?: string }>; isError?: boolean };
        error?: { message?: string };
      };
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBe(false);
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? '') as {
        posts: Array<{ id: string }>;
      };
      expect(payload.posts.map((post) => post.id)).toEqual(
        visiblePostIds.slice(1, 2)
      );
    });
  });
}

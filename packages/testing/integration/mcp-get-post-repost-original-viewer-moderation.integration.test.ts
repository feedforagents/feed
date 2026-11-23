/** MCP get_post follows viewer moderation. PRD §§8.1/12, MVP Phase 3. */
import { afterAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  excluded:
    'omits embedded originals for outgoing blocks, incoming blocks and mutes',
  quote: 'keeps a quote body while omitting its excluded original',
  visible: 'keeps visible originals for unaffected viewers',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP repost details on disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-get-post-original-moderation',
      file: 'packages/testing/integration/mcp-get-post-repost-original-viewer-moderation.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  mock.module('server-only', () => ({}));

  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { dbWrite, posts, userApiKeys, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { getAPIBaseUrl } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: detailGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );
  const { POST: mcpPOST } = await import(
    '../../../apps/web/src/app/api/mcp/route'
  );

  const viewerId = randomUUID();
  const bystanderId = randomUUID();
  const authorId = randomUUID();
  const blockedId = randomUUID();
  const mutedId = randomUUID();
  const blockingId = randomUUID();
  const viewerKey = generateApiKey();
  const bystanderKey = generateApiKey();
  const quoteContent = 'Commentary remains visible';
  const now = new Date();
  const timestamp = new Date(now.getTime() - 60_000);

  function original(author: string) {
    return {
      id: randomUUID(),
      authorId: author,
      content: 'Fixture original',
      timestamp,
    };
  }

  function repost(originalPostId: string, author: string, content = '') {
    return {
      id: randomUUID(),
      authorId: author,
      content,
      originalPostId,
      timestamp,
    };
  }

  const normalOriginal = original(authorId);
  const blockedOriginal = original(blockedId);
  const mutedOriginal = original(mutedId);
  const blockingOriginal = original(blockingId);
  const normalRepost = repost(normalOriginal.id, bystanderId);
  const blockedRepost = repost(blockedOriginal.id, bystanderId);
  const mutedRepost = repost(mutedOriginal.id, viewerId);
  const blockingRepost = repost(blockingOriginal.id, bystanderId);
  const quote = repost(blockedOriginal.id, viewerId, quoteContent);

  await dbWrite.transaction(async (tx) => {
    await tx.insert(users).values(
      [viewerId, bystanderId, authorId, blockedId, mutedId, blockingId].map(
        (id) => ({
          id,
          username: id,
          updatedAt: now,
        })
      )
    );
    await tx.insert(userApiKeys).values([
      { id: randomUUID(), userId: viewerId, keyHash: hashApiKey(viewerKey) },
      {
        id: randomUUID(),
        userId: bystanderId,
        keyHash: hashApiKey(bystanderKey),
      },
    ]);
    await tx.insert(userBlocks).values([
      { id: randomUUID(), blockerId: viewerId, blockedId },
      { id: randomUUID(), blockerId: blockingId, blockedId: viewerId },
    ]);
    await tx.insert(userMutes).values({
      id: randomUUID(),
      muterId: viewerId,
      mutedId,
    });
    await tx
      .insert(posts)
      .values([
        normalOriginal,
        blockedOriginal,
        mutedOriginal,
        blockingOriginal,
        normalRepost,
        blockedRepost,
        mutedRepost,
        blockingRepost,
        quote,
      ]);
  });

  const fixturePostIds = new Set<string>([
    normalRepost.id,
    blockedRepost.id,
    mutedRepost.id,
    blockingRepost.id,
    quote.id,
  ]);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/api/mcp') {
        const headers = new Headers(request.headers);
        headers.set('host', 'mcp-original.test');
        return mcpPOST(new NextRequest(request, { headers }));
      }
      const postId = path.replace(/^\/api\/posts\//, '');
      if (fixturePostIds.has(postId)) {
        return detailGET(new NextRequest(request), {
          params: Promise.resolve({ id: postId }),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));
  process.env.NEXT_PUBLIC_APP_URL = server.url.origin;
  expect(getAPIBaseUrl()).toBe(`${server.url.origin}/api`);

  const toolResult = z.object({
    result: z.object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ text: z.string() })),
    }),
  });
  const postResult = z.object({
    data: z.object({
      id: z.string(),
      content: z.string(),
      commentCount: z.number(),
      originalPostId: z.string().optional(),
      originalPost: z
        .object({ id: z.string(), authorId: z.string() })
        .optional(),
      isRepost: z.boolean().optional(),
      isQuote: z.union([z.boolean(), z.literal('')]).optional(),
      quoteComment: z.string().nullable().optional(),
    }),
  });

  async function getPost(postId: string, key: string) {
    const response = await fetch(new URL('/api/mcp', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: postId,
        method: 'tools/call',
        params: { name: 'get_post', arguments: { postId } },
      }),
    });
    expect(response.status).toBe(200);
    const result = toolResult.parse(await response.json()).result;
    expect(result.isError).not.toBe(true);
    return postResult.parse(JSON.parse(result.content[0]?.text ?? '')).data;
  }

  function expectHidden(post: z.infer<typeof postResult>['data']) {
    for (const key of [
      'originalPost',
      'originalPostId',
      'quoteComment',
      'isQuote',
      'isRepost',
    ] as const) {
      expect(post[key]).toBeUndefined();
    }
  }

  test(cases.excluded, async () => {
    for (const post of [blockedRepost, mutedRepost, blockingRepost]) {
      const result = await getPost(post.id, viewerKey);
      expect(result).toMatchObject({
        id: post.id,
        content: '',
        commentCount: 0,
      });
      expectHidden(result);
    }
  });

  test(cases.quote, async () => {
    const result = await getPost(quote.id, viewerKey);
    expect(result).toMatchObject({ id: quote.id, content: quoteContent });
    expectHidden(result);
  });

  test(cases.visible, async () => {
    expect(await getPost(normalRepost.id, viewerKey)).toMatchObject({
      isRepost: true,
      originalPostId: normalOriginal.id,
      originalPost: { id: normalOriginal.id, authorId },
    });
    expect(await getPost(blockedRepost.id, bystanderKey)).toMatchObject({
      isRepost: true,
      originalPostId: blockedOriginal.id,
      originalPost: { id: blockedOriginal.id, authorId: blockedId },
    });
  });
}

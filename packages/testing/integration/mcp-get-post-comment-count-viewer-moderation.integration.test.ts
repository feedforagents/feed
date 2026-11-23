/** Check MCP post details against the mounted web comment list. */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = [
  'the signed web comment list contains only the visible branch',
  'signed MCP post detail agrees with the viewer comment list',
  'an unmoderated MCP viewer gets the whole live comment count',
] as const;

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP comment counts in disposable PostgreSQL', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-get-post-comment-count-viewer-moderation',
      file: 'packages/testing/integration/mcp-get-post-comment-count-viewer-moderation.integration.test.ts',
      cases: [...cases],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  // The isolated process owns its environment and browser-server imports.
  process.env.STEWARD_JWT_SECRET = randomUUID();
  mock.module('server-only', () => ({}));

  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { comments, db, posts, userApiKeys, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { NextRequest } = await import('next/server');
  const { GET: detailGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/route'
  );
  const { GET: commentsGET } = await import(
    '../../../apps/web/src/app/api/posts/[id]/comments/route'
  );
  const { POST: mcpPOST } = await import(
    '../../../apps/web/src/app/api/mcp/route'
  );

  const viewerId = randomUUID();
  const bystanderId = randomUUID();
  const postAuthor = randomUUID();
  const usualAuthor = randomUUID();
  const blockedAuthor = randomUUID();
  const mutedAuthor = randomUUID();
  const blockerAuthor = randomUUID();
  const postId = randomUUID();
  const blockedComment = randomUUID();
  const viewerKey = generateApiKey();
  const bystanderKey = generateApiKey();

  let server: ReturnType<typeof Bun.serve> | undefined;
  let origin: string;
  let viewerToken: string;
  const initialAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeAll(async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60_000);

    await db.transaction(async (tx) => {
      await tx.insert(users).values(
        [
          viewerId,
          bystanderId,
          postAuthor,
          usualAuthor,
          blockedAuthor,
          mutedAuthor,
          blockerAuthor,
        ].map((id) => ({
          id,
          username: id,
          stewardId: id === viewerId ? viewerId : null,
          updatedAt: now,
        }))
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
        { id: randomUUID(), blockerId: viewerId, blockedId: blockedAuthor },
        { id: randomUUID(), blockerId: blockerAuthor, blockedId: viewerId },
      ]);
      await tx.insert(userMutes).values({
        id: randomUUID(),
        muterId: viewerId,
        mutedId: mutedAuthor,
      });
      await tx.insert(posts).values({
        id: postId,
        authorId: postAuthor,
        content: 'Disposable comment count fixture',
        timestamp: earlier,
        createdAt: earlier,
      });
      const comment = (
        authorId: string,
        id = randomUUID(),
        parentCommentId: string | null = null,
        deletedAt: Date | null = null
      ) => ({
        id,
        authorId,
        parentCommentId,
        deletedAt,
        postId,
        content: 'Fixture comment',
        createdAt: earlier,
        updatedAt: earlier,
      });
      await tx
        .insert(comments)
        .values([
          comment(usualAuthor),
          comment(usualAuthor),
          comment(blockedAuthor, blockedComment),
          comment(mutedAuthor),
          comment(blockerAuthor),
          comment(usualAuthor, randomUUID(), null, now),
          comment(usualAuthor, randomUUID(), blockedComment),
        ]);
    });
    viewerToken = await createStewardTestToken(viewerId);
    const context = { params: Promise.resolve({ id: postId }) };
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === `/api/posts/${postId}`) {
          return detailGET(new NextRequest(request), context);
        }
        if (path === `/api/posts/${postId}/comments`) {
          return commentsGET(new NextRequest(request), context);
        }
        if (path === '/api/mcp') {
          // Exercise ordinary per-user authentication.
          const headers = new Headers(request.headers);
          headers.set('host', 'comment-count.test');
          return mcpPOST(new NextRequest(request, { headers }));
        }
        return new Response(null, { status: 404 });
      },
    });
    origin = server.url.origin;
    process.env.NEXT_PUBLIC_APP_URL = origin;
  });

  afterAll(() => {
    server?.stop(true);
    if (initialAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = initialAppUrl;
  });

  const webResult = z.object({
    data: z.object({ total: z.number() }),
  });
  const toolResult = z.object({
    result: z.object({ content: z.array(z.object({ text: z.string() })) }),
  });
  const postResult = z.object({
    data: z.object({ commentCount: z.number() }),
  });

  async function mcpCommentCount(key: string) {
    const response = await fetch(`${origin}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Feed-Api-Key': key,
      },
      body: JSON.stringify({
        id: 'get-post',
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_post', arguments: { postId } },
      }),
    });
    expect(response.status).toBe(200);
    const { content } = toolResult.parse(await response.json()).result;
    return postResult.parse(JSON.parse(content[0]?.text ?? '')).data
      .commentCount;
  }

  test(cases[0], async () => {
    const response = await fetch(`${origin}/api/posts/${postId}/comments`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(response.status).toBe(200);
    expect(webResult.parse(await response.json()).data.total).toBe(2);
  });
  test(cases[1], async () => {
    expect(await mcpCommentCount(viewerKey)).toBe(2);
  });
  test(cases[2], async () => {
    expect(await mcpCommentCount(bystanderKey)).toBe(6);
  });
}

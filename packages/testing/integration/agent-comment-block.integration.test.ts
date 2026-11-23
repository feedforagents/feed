/** Agent and web comment-policy parity. PRD §§8.1/12, MVP Phases 3/5. */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  mcp: 'applies both block directions to signed MCP comments',
  a2a: 'applies both block directions to signed A2A comments',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks agent comment moderation in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'agent-comment-block',
      file: 'packages/testing/integration/agent-comment-block.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { db, comments, eq, posts, userApiKeys, userBlocks, users } =
    await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');

  const actor = 'comment-policy-actor';
  const authorBlocks = 'comment-policy-author-blocks';
  const actorBlocks = 'comment-policy-actor-blocks';
  const clean = 'comment-policy-clean';
  const missing = 'comment-policy-missing';
  const deleted = 'comment-policy-deleted';
  const key = generateApiKey();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [actor, authorBlocks, actorBlocks, clean].map((id) => ({
        id,
        username: id,
        updatedAt: now,
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'comment-policy-key',
      userId: actor,
      keyHash: hashApiKey(key),
    });
    await tx.insert(posts).values([
      ...[authorBlocks, actorBlocks, clean].map((id) => ({
        id,
        authorId: id,
        content: 'Comment policy fixture',
      })),
      {
        id: deleted,
        authorId: clean,
        content: 'Deleted comment policy fixture',
        deletedAt: now,
      },
    ]);
    await tx.insert(userBlocks).values([
      { id: authorBlocks, blockerId: authorBlocks, blockedId: actor },
      { id: actorBlocks, blockerId: actor, blockedId: actorBlocks },
    ]);
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      // Exercise user-key authentication instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'comment-policy.test');
      const routeRequest = new NextRequest(request, { headers });
      switch (new URL(request.url).pathname) {
        case '/api/mcp':
          return mcp(routeRequest);
        case '/api/a2a':
          return a2a(routeRequest);
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  afterAll(() => server.stop(true));

  async function request(protocol: 'mcp' | 'a2a', postId: string) {
    const args = { postId, content: `Comment policy fixture ${protocol}` };
    const envelope =
      protocol === 'mcp'
        ? {
            method: 'tools/call',
            params: { name: 'create_comment', arguments: args },
          }
        : {
            method: 'message/send',
            params: {
              message: {
                kind: 'message',
                role: 'user',
                contextId: actor,
                messageId: crypto.randomUUID(),
                parts: [
                  {
                    kind: 'data',
                    data: { operation: 'social.create_comment', params: args },
                  },
                ],
              },
            },
          };
    const response = await fetch(new URL(`/api/${protocol}`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${protocol}-${postId}`,
        ...envelope,
      }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  for (const protocol of ['mcp', 'a2a'] as const) {
    test(cases[protocol], async () => {
      const unsigned = await fetch(new URL(`/api/${protocol}`, server.url), {
        method: 'POST',
      });
      expect(unsigned.status).toBe(401);
      for (const postId of [authorBlocks, actorBlocks]) {
        expect(await request(protocol, postId)).toContain(
          'Cannot comment on this post'
        );
      }
      for (const postId of [missing, deleted]) {
        expect((await request(protocol, postId)).toLowerCase()).toContain(
          'not found'
        );
      }
      const result = JSON.parse(await request(protocol, clean)) as {
        result?: { isError?: boolean; status?: { state?: string } };
      };
      if (protocol === 'mcp') expect(result.result?.isError).toBe(false);
      else expect(result.result?.status?.state).toBe('completed');
      const stored = await db
        .select({
          postId: comments.postId,
          content: comments.content,
        })
        .from(comments)
        .where(eq(comments.authorId, actor));
      expect(stored.filter((row) => row.content.endsWith(protocol))).toEqual([
        { postId: clean, content: `Comment policy fixture ${protocol}` },
      ]);
    });
  }
}

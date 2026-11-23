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
  plugin:
    'applies both block directions to agent-core CREATE_COMMENT comments and replies',
  autonomous:
    'applies both parent-author block directions to autonomous comment replies',
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
  const { createCommentAction } = await import(
    '../../agents/src/plugins/plugin-agent-core/src/actions/create-comment'
  );
  const { executeDirectComment } = await import(
    '../../agents/src/autonomous/DirectExecutors'
  );
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');

  const actor = 'comment-policy-actor';
  const authorBlocks = 'comment-policy-author-blocks';
  const actorBlocks = 'comment-policy-actor-blocks';
  const clean = 'comment-policy-clean';
  const missing = 'comment-policy-missing';
  const deleted = 'comment-policy-deleted';
  // Snowflake IDs: CREATE_COMMENT validates parentCommentId with the API schema.
  const parentByAuthorBlocks = '700000000000000001';
  const parentByActorBlocks = '700000000000000002';
  const parentByClean = '700000000000000003';
  const autonomousParentByClean = '700000000000000004';
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
    // Replies on the clean post whose parent author is on either side of a block.
    await tx.insert(comments).values(
      (
        [
          [parentByAuthorBlocks, authorBlocks],
          [parentByActorBlocks, actorBlocks],
          [parentByClean, clean],
          [autonomousParentByClean, clean],
        ] as const
      ).map(([id, authorId]) => ({
        id,
        postId: clean,
        authorId,
        content: 'Comment policy parent fixture',
        updatedAt: now,
      }))
    );
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

  test(cases.plugin, async () => {
    // The agent runtime ID is the agent's user ID (AgentRuntimeManager).
    const runtime = { agentId: actor } as unknown as Parameters<
      NonNullable<typeof createCommentAction.handler>
    >[0];
    const run = (postId: string, parentCommentId?: string) =>
      createCommentAction.handler(
        runtime,
        {} as never,
        {
          values: {},
          data: {
            actionParams: {
              postId,
              content: `Comment policy fixture plugin ${postId}`,
              ...(parentCommentId ? { parentCommentId } : {}),
            },
          },
          text: '',
        } as never
      );

    for (const [postId, parent] of [
      [authorBlocks, undefined],
      [actorBlocks, undefined],
      [clean, parentByAuthorBlocks],
      [clean, parentByActorBlocks],
    ] as const) {
      expect(await run(postId, parent)).toMatchObject({
        success: false,
        text: 'Cannot comment on this post.',
        error: 'BLOCKED_USER',
      });
    }
    expect(await run(clean)).toMatchObject({ success: true });
    expect(await run(clean, parentByClean)).toMatchObject({
      success: true,
      values: { isReply: true },
    });

    const stored = await db
      .select({
        postId: comments.postId,
        parentCommentId: comments.parentCommentId,
        content: comments.content,
      })
      .from(comments)
      .where(eq(comments.authorId, actor));
    // Only the two unblocked writes reached the database.
    expect(
      stored
        .filter((row) =>
          row.content.startsWith('Comment policy fixture plugin')
        )
        .map((row) => row.parentCommentId)
        .sort()
    ).toEqual([parentByClean, null]);
  });

  test(cases.autonomous, async () => {
    // MultiStepExecutor REPLY_COMMENT/COMMENT path used by the agent ticks.
    const reply = (parentCommentId: string) =>
      executeDirectComment({
        agentUserId: actor,
        postId: clean,
        content: `Comment policy fixture autonomous ${parentCommentId}`,
        parentCommentId,
      });
    for (const parent of [parentByAuthorBlocks, parentByActorBlocks]) {
      expect(await reply(parent)).toEqual({
        success: false,
        error: 'Cannot comment on this post',
      });
    }
    expect(await reply(autonomousParentByClean)).toMatchObject({
      success: true,
    });

    const stored = await db
      .select({
        parentCommentId: comments.parentCommentId,
        content: comments.content,
      })
      .from(comments)
      .where(eq(comments.authorId, actor));
    expect(
      stored
        .filter((row) =>
          row.content.startsWith('Comment policy fixture autonomous')
        )
        .map((row) => row.parentCommentId)
    ).toEqual([autonomousParentByClean]);
  });
}

/** Agent post and comment mentions. PRD §§7.1/8.1/12 and MVP Phases 3/5. */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  mcpPost: 'notifies users an MCP create_post mentions',
  mcpComment: 'notifies users an MCP create_comment mentions',
  a2aPost: 'notifies users an A2A social.create_post mentions',
  a2aComment: 'notifies users an A2A social.create_comment mentions',
  mcpCommentLimit:
    'refuses the 11th MCP create_comment in a minute without notifying',
  a2aPostLimit:
    'refuses the 4th A2A social.create_post in a minute without notifying',
  a2aCommentLimit:
    'refuses the 11th A2A social.create_comment in a minute without notifying',
  outage: 'returns the committed write when the mention notification fails',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks agent mention notifications in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'agent-mention-notification',
      file: 'packages/testing/integration/agent-mention-notification.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    and,
    comments,
    db,
    eq,
    notifications,
    posts,
    sql,
    userApiKeys,
    userBlocks,
    users,
  } = await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { FeedAgentExecutor } = await import(
    '../../a2a/src/executors/feed-executor'
  );
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const agent = 'mention_agent';
  const reader = 'mention_reader';
  const other = 'mention_other';
  const blocker = 'mention_blocker';
  // Fresh authors so the limit cases start from an empty window.
  const mcpLimited = 'mention_mcp_limited';
  const a2aLimited = 'mention_a2a_limited';
  const outageAgent = 'mention_outage_agent';
  const commentTarget = 'mention-comment-target';
  const key = generateApiKey();
  const mcpLimitedKey = generateApiKey();
  const outageKey = generateApiKey();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [agent, reader, other, blocker, mcpLimited, a2aLimited, outageAgent].map(
        (id) => ({
          id,
          username: id,
          displayName: id,
          updatedAt: now,
        })
      )
    );
    await tx.insert(userApiKeys).values(
      (
        [
          [agent, key],
          [mcpLimited, mcpLimitedKey],
          [outageAgent, outageKey],
        ] as const
      ).map(([userId, apiKey]) => ({
        id: `${userId}-key`,
        userId,
        keyHash: hashApiKey(apiKey),
      }))
    );
    await tx.insert(posts).values({
      id: commentTarget,
      authorId: agent,
      content: 'Mention fixture post',
      timestamp: new Date(now.getTime() - 60_000),
    });
    // A mentioned user who blocked the author gets nothing, as on the website.
    await tx.insert(userBlocks).values({
      id: 'mention-blocker-block',
      blockerId: blocker,
      blockedId: agent,
    });
  });

  // Self, duplicate, unknown and blocked mentions must not notify anyone.
  const mentionText = (label: string) =>
    `${label} @${reader} and @${other} @${reader} @${agent} @${blocker} @mention_nobody`;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/mcp') {
        return new Response(null, { status: 404 });
      }
      // Exercise the per-user key flow instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'mention-notification.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));
  const endpoint = new URL('/api/mcp', server.url);

  async function callToolRaw(
    name: string,
    args: Record<string, string>,
    apiKey = key
  ) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': apiKey },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    return {
      isError: body.result?.isError,
      text: body.result?.content?.[0]?.text ?? '',
    };
  }

  async function callTool(
    name: string,
    args: Record<string, string>,
    apiKey = key
  ) {
    const { isError, text } = await callToolRaw(name, args, apiKey);
    expect(isError).toBe(false);
    return JSON.parse(text || '{}') as Record<string, string>;
  }

  async function postByContent(content: string, authorId = agent) {
    const [row] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.authorId, authorId), eq(posts.content, content)));
    expect(row).toBeDefined();
    return row!.id;
  }

  async function commentByContent(content: string) {
    const [row] = await db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(eq(comments.postId, commentTarget), eq(comments.content, content))
      );
    expect(row).toBeDefined();
    return row!.id;
  }

  async function mentionNotifications(postId: string, commentId?: string) {
    const rows = await db
      .select({
        userId: notifications.userId,
        actorId: notifications.actorId,
        postId: notifications.postId,
        commentId: notifications.commentId,
        message: notifications.message,
      })
      .from(notifications)
      .where(
        and(eq(notifications.type, 'mention'), eq(notifications.postId, postId))
      );
    const forTarget = rows.filter(
      (row) => (row.commentId ?? undefined) === commentId
    );
    const summary = forTarget.map((row) => row.userId).sort();
    console.log(
      `MENTION_NOTIFICATIONS ${commentId ? 'comment' : 'post'} recipients=${JSON.stringify(summary)}`
    );
    return forTarget.sort((a, b) => a.userId.localeCompare(b.userId));
  }

  function expected(postId: string, commentId: string | null, kind: string) {
    return [other, reader].map((userId) => ({
      userId,
      actorId: agent,
      postId,
      commentId,
      message: `${agent} mentioned you in a ${kind}`,
    }));
  }

  test(cases.mcpPost, async () => {
    const content = mentionText('MCP post');
    await callTool('create_post', { content });
    const postId = await postByContent(content);
    expect(await mentionNotifications(postId)).toEqual(
      expected(postId, null, 'post')
    );
  });

  test(cases.mcpComment, async () => {
    const content = mentionText('MCP comment');
    await callTool('create_comment', { postId: commentTarget, content });
    const commentId = await commentByContent(content);
    expect(await mentionNotifications(commentTarget, commentId)).toEqual(
      expected(commentTarget, commentId, 'comment')
    );
  });

  test(cases.a2aPost, async () => {
    const content = mentionText('A2A post');
    await FeedAgentExecutor.executeDirectly(
      'social.create_post',
      { content },
      agent
    );
    const postId = await postByContent(content);
    expect(await mentionNotifications(postId)).toEqual(
      expected(postId, null, 'post')
    );
  });

  test(cases.a2aComment, async () => {
    const content = mentionText('A2A comment');
    await FeedAgentExecutor.executeDirectly(
      'social.create_comment',
      { postId: commentTarget, content },
      agent
    );
    const commentId = await commentByContent(content);
    expect(await mentionNotifications(commentTarget, commentId)).toEqual(
      expected(commentTarget, commentId, 'comment')
    );
  });

  // Count the rows and mention notifications one author left behind.
  async function limitOutcome(label: string, actorId: string) {
    const count = async (query: Promise<{ value: number }[]>) =>
      (await query)[0]?.value ?? 0;
    const postCount = await count(
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(posts)
        .where(eq(posts.authorId, actorId))
    );
    const commentCount = await count(
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(comments)
        .where(eq(comments.authorId, actorId))
    );
    const notified = await count(
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'mention'),
            eq(notifications.actorId, actorId)
          )
        )
    );
    console.log(
      `MENTION_RATE_LIMIT ${label} posts=${postCount} comments=${commentCount} mention_notifications=${notified}`
    );
    return { postCount, commentCount, notified };
  }

  test(cases.mcpCommentLimit, async () => {
    const args = (n: number) => ({
      postId: commentTarget,
      content: `MCP limit comment ${n} @${reader}`,
    });
    for (let n = 1; n <= 10; n++) {
      await callTool('create_comment', args(n), mcpLimitedKey);
    }
    const refused = await callToolRaw(
      'create_comment',
      args(11),
      mcpLimitedKey
    );
    expect(await limitOutcome('mcp_comment', mcpLimited)).toEqual({
      postCount: 0,
      commentCount: 10,
      notified: 10,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Rate limit exceeded');
  });

  test(cases.a2aPostLimit, async () => {
    for (let n = 1; n <= 3; n++) {
      await FeedAgentExecutor.executeDirectly(
        'social.create_post',
        { content: `A2A limit post ${n} @${reader}` },
        a2aLimited
      );
    }
    const refused = await FeedAgentExecutor.executeDirectly(
      'social.create_post',
      { content: `A2A limit post 4 @${reader}` },
      a2aLimited
    ).catch((error: Error) => error);
    const outcome = await limitOutcome('a2a_post', a2aLimited);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain('Rate limit exceeded');
    expect(outcome).toEqual({ postCount: 3, commentCount: 0, notified: 3 });
  });

  test(cases.a2aCommentLimit, async () => {
    const params = (n: number) => ({
      postId: commentTarget,
      content: `A2A limit comment ${n} @${reader}`,
    });
    for (let n = 1; n <= 10; n++) {
      await FeedAgentExecutor.executeDirectly(
        'social.create_comment',
        params(n),
        a2aLimited
      );
    }
    const refused = await FeedAgentExecutor.executeDirectly(
      'social.create_comment',
      params(11),
      a2aLimited
    ).catch((error: Error) => error);
    const outcome = await limitOutcome('a2a_comment', a2aLimited);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain('Rate limit exceeded');
    expect(outcome).toEqual({ postCount: 3, commentCount: 10, notified: 13 });
  });

  test(cases.outage, async () => {
    // Force every new mention INSERT to fail inside the lease; NOT VALID
    // leaves the rows the earlier cases wrote alone.
    await db.execute(sql`
      ALTER TABLE "Notification" ADD CONSTRAINT fixture_mention_outage
      CHECK ("type" <> 'mention') NOT VALID
    `);

    const mcpPost = mentionText('MCP outage post');
    const postResult = await callTool(
      'create_post',
      { content: mcpPost },
      outageKey
    );
    const mcpPostId = await postByContent(mcpPost, outageAgent);
    expect(postResult.postId).toBe(mcpPostId);

    const mcpComment = mentionText('MCP outage comment');
    const commentResult = await callTool(
      'create_comment',
      { postId: commentTarget, content: mcpComment },
      outageKey
    );
    expect(commentResult.commentId).toBe(await commentByContent(mcpComment));

    const a2aPost = mentionText('A2A outage post');
    await FeedAgentExecutor.executeDirectly(
      'social.create_post',
      { content: a2aPost },
      outageAgent
    );
    await postByContent(a2aPost, outageAgent);

    const a2aComment = mentionText('A2A outage comment');
    await FeedAgentExecutor.executeDirectly(
      'social.create_comment',
      { postId: commentTarget, content: a2aComment },
      outageAgent
    );
    await commentByContent(a2aComment);

    expect(await limitOutcome('outage', outageAgent)).toEqual({
      postCount: 2,
      commentCount: 2,
      notified: 0,
    });
  });
}

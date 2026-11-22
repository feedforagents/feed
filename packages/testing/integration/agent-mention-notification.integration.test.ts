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
  outage: 'returns the committed MCP post when the mention notification fails',
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
  const commentTarget = 'mention-comment-target';
  const key = generateApiKey();
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [agent, reader, other, blocker].map((id) => ({
        id,
        username: id,
        displayName: id,
        updatedAt: now,
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'mention-notification-key',
      userId: agent,
      keyHash: hashApiKey(key),
    });
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

  async function callTool(name: string, args: Record<string, string>) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
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
    expect(body.result?.isError).toBe(false);
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<
      string,
      string
    >;
  }

  async function postByContent(content: string) {
    const [row] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.authorId, agent), eq(posts.content, content)));
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

  test(cases.outage, async () => {
    // Force every new mention INSERT to fail inside the lease; NOT VALID
    // leaves the rows the earlier cases wrote alone.
    await db.execute(sql`
      ALTER TABLE "Notification" ADD CONSTRAINT fixture_mention_outage
      CHECK ("type" <> 'mention') NOT VALID
    `);
    const content = mentionText('MCP outage post');
    const result = await callTool('create_post', { content });
    const postId = await postByContent(content);
    expect(result.postId).toBe(postId);
    expect(await mentionNotifications(postId)).toEqual([]);
  });
}

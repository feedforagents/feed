/** Retained comments and notifications. PRD §§8.1/12 and MVP Phases 3/5. */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  notification: 'notifies the author after persisting a signed MCP comment',
  self: 'persists self-comments without notifying the author',
  block: 'refuses both directions of a block without persisting or notifying',
  deleted: 'refuses a comment on a deleted post',
  missing: 'refuses a comment on an unknown post',
  scheduled: 'refuses a comment on a future post',
  outage: 'returns the committed comment when the notification write fails',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP comment notifications in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-comment-notification',
      file: 'packages/testing/integration/mcp-comment-notification.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
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
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const sender = 'comment-notification-sender';
  const author = 'comment-notification-author';
  const authorBlocked = 'comment-notification-author-blocked';
  const senderBlocked = 'comment-notification-sender-blocked';
  const live = 'comment-notification-live';
  const self = 'comment-notification-self';
  const missing = 'comment-notification-missing';
  const deleted = 'comment-notification-deleted';
  const scheduled = 'comment-notification-scheduled';
  const outage = 'comment-notification-outage';
  const content = 'MCP comment notification fixture';
  const key = generateApiKey();
  const now = new Date();
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 3_600_000);

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [sender, author, authorBlocked, senderBlocked].map((id) => ({
        id,
        username: id,
        updatedAt: now,
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'comment-notification-key',
      userId: sender,
      keyHash: hashApiKey(key),
    });
    await tx.insert(posts).values([
      { id: live, authorId: author, content, timestamp: past },
      { id: self, authorId: sender, content, timestamp: past },
      { id: authorBlocked, authorId: authorBlocked, content, timestamp: past },
      { id: senderBlocked, authorId: senderBlocked, content, timestamp: past },
      {
        id: deleted,
        authorId: author,
        content,
        timestamp: past,
        deletedAt: now,
      },
      { id: scheduled, authorId: author, content, timestamp: future },
      { id: outage, authorId: author, content, timestamp: past },
    ]);
    await tx.insert(userBlocks).values([
      { id: authorBlocked, blockerId: authorBlocked, blockedId: sender },
      { id: senderBlocked, blockerId: sender, blockedId: senderBlocked },
    ]);
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api/mcp') {
        return new Response(null, { status: 404 });
      }
      // Exercise the per-user key flow instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'comment-notification.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));
  const endpoint = new URL('/api/mcp', server.url);

  async function comment(postId: string) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: postId,
        method: 'tools/call',
        params: {
          name: 'create_comment',
          arguments: { postId, content },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result).toBeDefined();
    return body.result;
  }

  async function commentsOn(postId: string) {
    return db
      .select({
        id: comments.id,
        authorId: comments.authorId,
        content: comments.content,
      })
      .from(comments)
      .where(eq(comments.postId, postId));
  }

  async function notificationsOn(postId: string) {
    return db
      .select({
        userId: notifications.userId,
        type: notifications.type,
        actorId: notifications.actorId,
        commentId: notifications.commentId,
      })
      .from(notifications)
      .where(eq(notifications.postId, postId));
  }

  async function expectRefused(postId: string, message: string) {
    const result = await comment(postId);
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text?.toLowerCase()).toContain(message);
    expect(await commentsOn(postId)).toEqual([]);
    expect(await notificationsOn(postId)).toEqual([]);
  }

  test(cases.notification, async () => {
    const unsigned = await fetch(endpoint, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    expect((await comment(live))?.isError).toBe(false);
    const saved = await commentsOn(live);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ authorId: sender, content });
    expect(await notificationsOn(live)).toEqual([
      {
        userId: author,
        type: 'comment',
        actorId: sender,
        commentId: saved[0]?.id ?? null,
      },
    ]);
  });

  test(cases.self, async () => {
    expect((await comment(self))?.isError).toBe(false);
    expect(await commentsOn(self)).toEqual([
      { id: expect.any(String), authorId: sender, content },
    ]);
    expect(await notificationsOn(self)).toEqual([]);
  });

  test(cases.block, async () => {
    for (const postId of [authorBlocked, senderBlocked]) {
      await expectRefused(postId, 'cannot comment on this post');
    }
  });

  for (const [postId, name, message] of [
    [deleted, cases.deleted, 'deleted'],
    [missing, cases.missing, 'not found'],
    [scheduled, cases.scheduled, 'not found'],
  ] as const) {
    test(name, () => expectRefused(postId, message));
  }

  test(cases.outage, async () => {
    // Force just this fixture's notification INSERT to fail inside the lease.
    await db.execute(sql`
      ALTER TABLE "Notification" ADD CONSTRAINT fixture_notification_outage
      CHECK ("postId" <> 'comment-notification-outage')
    `);
    expect((await comment(outage))?.isError).toBe(false);
    expect(await commentsOn(outage)).toEqual([
      { id: expect.any(String), authorId: sender, content },
    ]);
    expect(await notificationsOn(outage)).toEqual([]);
  });
}

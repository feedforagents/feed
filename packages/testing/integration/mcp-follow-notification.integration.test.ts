/** Retained follow notifications. PRD §§8.1/12 and MVP Phases 3/5. */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  newFollow: 'notifies the target of a newly committed follow',
  duplicate: 'keeps duplicate follows successful without new notifications',
  self: 'rejects self-follows without persisting or notifying',
  block: 'refuses both directions of a block without persisting or notifying',
  outage: 'returns the committed follow when the notification write fails',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP follow notifications in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-follow-notification',
      file: 'packages/testing/integration/mcp-follow-notification.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    and,
    db,
    eq,
    follows,
    notifications,
    sql,
    userApiKeys,
    userBlocks,
    users,
  } = await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const follower = 'mcp-follow-actor';
  const target = 'mcp-follow-target';
  const alreadyFollowed = 'mcp-follow-previous';
  const blockedByTarget = 'mcp-follow-target-blocked';
  const blockedByFollower = 'mcp-follow-actor-blocked';
  const outage = 'mcp-follow-outage';
  const key = generateApiKey();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [
        follower,
        target,
        alreadyFollowed,
        blockedByTarget,
        blockedByFollower,
        outage,
      ].map((id) => ({
        id,
        username: id,
        updatedAt: new Date(),
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'mcp-follow-key',
      userId: follower,
      keyHash: hashApiKey(key),
    });
    await tx.insert(follows).values({
      id: 'mcp-follow-existing',
      followerId: follower,
      followingId: alreadyFollowed,
    });
    await tx.insert(userBlocks).values([
      { id: blockedByTarget, blockerId: blockedByTarget, blockedId: follower },
      {
        id: blockedByFollower,
        blockerId: follower,
        blockedId: blockedByFollower,
      },
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
      headers.set('host', 'follow-notification.test');
      return POST(new NextRequest(request, { headers }));
    },
  });
  afterAll(() => server.stop(true));
  const endpoint = new URL('/api/mcp', server.url);

  async function follow(userId: string) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: 'follow_user', arguments: { userId } },
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result).toBeDefined();
    return body.result;
  }

  function followsTo(userId: string) {
    return db
      .select({ id: follows.id })
      .from(follows)
      .where(
        and(eq(follows.followerId, follower), eq(follows.followingId, userId))
      );
  }

  function noticesTo(userId: string) {
    return db
      .select({
        userId: notifications.userId,
        type: notifications.type,
        actorId: notifications.actorId,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId));
  }

  async function expectRefused(userId: string, reason: string) {
    const result = await follow(userId);
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain(reason);
    expect(await followsTo(userId)).toEqual([]);
    expect(await noticesTo(userId)).toEqual([]);
  }

  test(cases.newFollow, async () => {
    const unsigned = await fetch(endpoint, { method: 'POST' });
    expect(unsigned.status).toBe(401);
    expect((await follow(target))?.isError).toBe(false);
    expect(await followsTo(target)).toHaveLength(1);
    expect(await noticesTo(target)).toEqual([
      { userId: target, type: 'follow', actorId: follower },
    ]);
  });

  test(cases.duplicate, async () => {
    // This existing follow has no notice for the service's deduper to suppress.
    // Repeat calls must take the existing-edge path regardless of notification state.
    const repeated = await Promise.all([
      follow(alreadyFollowed),
      follow(alreadyFollowed),
    ]);
    expect(repeated.map((result) => result?.isError)).toEqual([false, false]);
    expect(await followsTo(alreadyFollowed)).toEqual([
      { id: 'mcp-follow-existing' },
    ]);
    expect(await noticesTo(alreadyFollowed)).toEqual([]);
  });

  test(cases.self, () => expectRefused(follower, 'Cannot follow yourself'));

  test(cases.block, async () => {
    for (const userId of [blockedByTarget, blockedByFollower]) {
      await expectRefused(userId, 'Cannot follow this user');
    }
  });

  test(cases.outage, async () => {
    // Force just this fixture's follow notification INSERT to fail inside the lease.
    await db.execute(sql`
      ALTER TABLE "Notification" ADD CONSTRAINT fixture_follow_notification_outage
      CHECK ("userId" <> 'mcp-follow-outage' OR "type" <> 'follow')
    `);
    expect((await follow(outage))?.isError).toBe(false);
    expect(await followsTo(outage)).toHaveLength(1);
    expect(await noticesTo(outage)).toEqual([]);
  });
}

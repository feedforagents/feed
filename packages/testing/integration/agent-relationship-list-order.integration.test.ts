/**
 * Agent block, mute and favorite lists must use the web lists' total
 * order (createdAt desc, id desc): GET /api/moderation/blocks, GET
 * /api/moderation/mutes and GET /api/profiles/favorites. PRD sections
 * 8.1/12, MVP Phases 3/5.
 *
 * The MCP and A2A list handlers ordered by createdAt alone, so rows
 * sharing one timestamp came back in storage order: offset pages could
 * repeat one row and skip another, and a limit cut kept an arbitrary
 * part of a tied block.
 */
import { afterAll, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const cases = {
  mcp: 'pages signed MCP block, mute and favorite lists in total order',
  a2a: 'pages signed A2A block, mute and favorite lists in total order',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks agent list order in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'agent-relationship-list-order',
      file: 'packages/testing/integration/agent-relationship-list-order.integration.test.ts',
      cases: Object.values(cases),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { db, favorites, userApiKeys, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');

  const viewer = 'list-order-viewer';
  const key = generateApiKey();
  const tiedAt = new Date('2026-01-02T03:04:05.678Z');
  const COUNT = 24;
  const PAGE = 5;

  // Targets are inserted in a shuffled order, so storage order is not
  // the id order. Row ids equal the target ids.
  const targets = Array.from(
    { length: COUNT },
    (_, i) => `list-order-target-${String(i).padStart(2, '0')}`
  );
  const insertOrder = targets
    .map((id, i) => ({ id, rank: (i * 7) % COUNT }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ id }) => id);
  const totalOrder = [...targets].sort().reverse();

  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [viewer, ...targets].map((id) => ({
        id,
        username: id,
        updatedAt: tiedAt,
      }))
    );
    await tx.insert(userApiKeys).values({
      id: 'list-order-key',
      userId: viewer,
      keyHash: hashApiKey(key),
    });
    for (const id of insertOrder) {
      await tx
        .insert(userBlocks)
        .values({ id, blockerId: viewer, blockedId: id, createdAt: tiedAt });
      await tx
        .insert(userMutes)
        .values({ id, muterId: viewer, mutedId: id, createdAt: tiedAt });
      await tx.insert(favorites).values({
        id,
        userId: viewer,
        targetUserId: id,
        createdAt: tiedAt,
      });
    }
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      // Exercise user-key authentication instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'list-order.test');
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

  async function call(
    protocol: 'mcp' | 'a2a',
    name: string,
    args: Record<string, number>
  ): Promise<Record<string, unknown>> {
    const envelope =
      protocol === 'mcp'
        ? { method: 'tools/call', params: { name, arguments: args } }
        : {
            method: 'message/send',
            params: {
              message: {
                kind: 'message',
                role: 'user',
                contextId: viewer,
                messageId: crypto.randomUUID(),
                parts: [
                  { kind: 'data', data: { operation: name, params: args } },
                ],
              },
            },
          };
    const response = await fetch(new URL(`/api/${protocol}`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: name, ...envelope }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: {
        isError?: boolean;
        content?: { text: string }[];
        artifacts?: { parts: { data: Record<string, unknown> }[] }[];
      };
    };
    if (protocol === 'mcp') {
      expect(body.result?.isError).toBe(false);
      return JSON.parse(body.result?.content?.[0]?.text ?? '{}');
    }
    const data = body.result?.artifacts?.[0]?.parts[0]?.data;
    expect(data).toBeDefined();
    return data ?? {};
  }

  async function walk(
    load: (offset: number) => Promise<string[]>
  ): Promise<string[]> {
    const seen: string[] = [];
    for (let offset = 0; offset < COUNT; offset += PAGE) {
      seen.push(...(await load(offset)));
    }
    return seen;
  }

  // One line per protocol: rows a walk repeated or never reached.
  function report(protocol: string, observed: Record<string, string[]>) {
    const lines = Object.entries(observed).map(([name, seen]) => {
      const repeated = seen.filter((id, i) => seen.indexOf(id) !== i);
      const expected =
        seen.length < COUNT ? totalOrder.slice(0, seen.length) : totalOrder;
      const missing = expected.filter((id) => !seen.includes(id));
      return `${name} rows=${seen.length} repeated=[${repeated}] missing=[${missing}]`;
    });
    console.log(`LIST_ORDER ${protocol} ${lines.join('; ')}`);
  }

  const ids = (rows: unknown, field: string) =>
    (rows as Record<string, unknown>[]).map((row) =>
      String(row[field] ?? (row.user as { id: string } | undefined)?.id)
    );

  test(cases.mcp, async () => {
    const unsigned = await fetch(new URL('/api/mcp', server.url), {
      method: 'POST',
    });
    expect(unsigned.status).toBe(401);
    const observed = {
      get_blocks: ids(
        (await call('mcp', 'get_blocks', {})).blockedUsers,
        'userId'
      ),
      get_mutes: ids((await call('mcp', 'get_mutes', {})).mutedUsers, 'userId'),
      get_favorites: await walk(async (offset) =>
        ids(
          (await call('mcp', 'get_favorites', { limit: PAGE, offset }))
            .favorites,
          'userId'
        )
      ),
    };
    report('mcp', observed);
    expect(observed).toEqual({
      get_blocks: totalOrder,
      get_mutes: totalOrder,
      get_favorites: totalOrder,
    });
  });

  test(cases.a2a, async () => {
    const unsigned = await fetch(new URL('/api/a2a', server.url), {
      method: 'POST',
    });
    expect(unsigned.status).toBe(401);
    const observed = {
      'moderation.get_blocks': await walk(async (offset) =>
        ids(
          (
            await call('a2a', 'moderation.get_blocks', {
              limit: PAGE,
              offset,
            })
          ).blocks,
          'blockedId'
        )
      ),
      'moderation.get_mutes': await walk(async (offset) =>
        ids(
          (await call('a2a', 'moderation.get_mutes', { limit: PAGE, offset }))
            .mutes,
          'mutedId'
        )
      ),
      'favorites.list': ids(
        (await call('a2a', 'favorites.list', { limit: PAGE })).favorites,
        'targetUserId'
      ),
    };
    report('a2a', observed);
    expect(observed).toEqual({
      'moderation.get_blocks': totalOrder,
      'moderation.get_mutes': totalOrder,
      'favorites.list': totalOrder.slice(0, PAGE),
    });
  });
}

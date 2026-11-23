/** MCP people search shares web moderation rules (PRD §§8.1–8.2/12, MVP 3/5). */
import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'MCP search_users viewer moderation';
const cases = {
  eligible: 'keeps global eligibility and display-name matching',
  block: 'excludes users the viewer has blocked',
  mute: 'excludes users the viewer has muted',
  inbound: 'excludes users who have blocked the viewer',
  limit: 'applies moderation before the result limit',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP people search in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-search-users-viewer-moderation',
      file: 'packages/testing/integration/mcp-search-users-viewer-moderation.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { closeDatabase, db, userApiKeys, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { POST } = await import('../../../apps/web/src/app/api/mcp/route');

  const needle = 'search1885';
  const caller = 'viewer-1885';
  const observer = 'observer-1885';
  const blocked = 'blocked-1885';
  const muted = 'muted-1885';
  const blocker = 'blocker-1885';
  const visible = 'visible-1885';
  const callerKey = generateApiKey();
  const observerKey = generateApiKey();

  async function search(key: string, limit = 50): Promise<string[]> {
    const result = await POST(
      new NextRequest('http://people-search.test/api/mcp', {
        method: 'POST',
        headers: {
          host: 'people-search.test',
          'content-type': 'application/json',
          'X-Feed-Api-Key': key,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'search-users-fixture',
          method: 'tools/call',
          params: {
            name: 'search_users',
            arguments: { query: needle, limit },
          },
        }),
      })
    );
    expect(result.status).toBe(200);
    const body = (await result.json()) as {
      result?: { isError?: boolean; content?: { text: string }[] };
    };
    expect(body.result?.isError).not.toBe(true);
    const payload = body.result?.content?.[0]?.text;
    if (!payload) throw new Error('Search returned no MCP result');
    const data = JSON.parse(payload) as { users: { id: string }[] };
    return data.users.map((user) => user.id);
  }

  describe(suite, () => {
    beforeAll(async () => {
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(users).values([
          { id: caller, username: caller, updatedAt: now },
          { id: observer, username: observer, updatedAt: now },
          ...[blocked, muted, blocker].map((id) => ({
            id,
            username: `${needle}-${id}`,
            updatedAt: now,
          })),
          {
            id: visible,
            username: visible,
            displayName: `Eligible ${needle.toUpperCase()}`,
            updatedAt: now,
          },
          {
            id: 'banned-1885',
            username: `${needle}-banned`,
            isBanned: true,
            updatedAt: now,
          },
          {
            id: 'flagged-1885',
            username: `${needle}-flagged`,
            isTest: true,
            updatedAt: now,
          },
          {
            id: 'test-prefix-1885',
            username: `${needle}-prefix`,
            isTest: false,
            updatedAt: now,
          },
        ]);
        await tx.insert(userApiKeys).values([
          { id: caller, userId: caller, keyHash: hashApiKey(callerKey) },
          { id: observer, userId: observer, keyHash: hashApiKey(observerKey) },
        ]);
        await tx.insert(userBlocks).values([
          { id: blocked, blockerId: caller, blockedId: blocked },
          { id: blocker, blockerId: blocker, blockedId: caller },
        ]);
        await tx.insert(userMutes).values({
          id: muted,
          muterId: caller,
          mutedId: muted,
        });
      });
    });

    afterAll(async () => {
      await closeDatabase();
    });

    it(cases.eligible, async () => {
      expect((await search(observerKey)).sort()).toEqual(
        [blocked, muted, blocker, visible].sort()
      );
    });

    it(cases.block, async () => {
      expect(await search(callerKey)).not.toContain(blocked);
    });

    it(cases.mute, async () => {
      expect(await search(callerKey)).not.toContain(muted);
    });

    it(cases.inbound, async () => {
      expect(await search(callerKey)).not.toContain(blocker);
    });

    it(cases.limit, async () => {
      expect(await search(callerKey, 1)).toEqual([visible]);
    });
  });
}

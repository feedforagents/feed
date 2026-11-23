/** Account deletion and the account API keys. PRD sections 7.1/8.1, MVP Phases 2/3. */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const deletionCase =
  'revokes the deleted account API keys for MCP, A2A and the shared validator';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks API keys after account deletion in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'account-deletion-api-keys',
      file: 'packages/testing/integration/account-deletion-api-keys.integration.test.ts',
      cases: [deletionCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  // The Next.js server-only marker has no runtime behavior under Bun.
  mock.module('server-only', () => ({}));
  const { db, eq, inArray, userApiKeys, users } = await import('@feed/db');
  const { clearApiKeyCache, generateApiKey, hashApiKey, validateUserApiKey } =
    await import('@feed/api');
  const { NextRequest } = await import('next/server');
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');
  const { POST: deleteAccount } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  );

  const owner = 'deleted-key-owner';
  const control = 'deleted-key-control';
  const ownerKey = generateApiKey();
  const controlKey = generateApiKey();
  const earlierRevocation = new Date('2026-01-02T03:04:05.000Z');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      // Exercise user-key authentication instead of the local dev bypass.
      const headers = new Headers(request.headers);
      headers.set('host', 'deleted-key.test');
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

  function call(protocol: 'mcp' | 'a2a', key: string) {
    const envelope =
      protocol === 'mcp'
        ? {
            method: 'tools/call',
            params: { name: 'get_balance', arguments: {} },
          }
        : {
            method: 'message/send',
            params: {
              message: {
                kind: 'message',
                role: 'user',
                messageId: crypto.randomUUID(),
                parts: [
                  {
                    kind: 'data',
                    data: { operation: 'portfolio.get_balance', params: {} },
                  },
                ],
              },
            },
          };
    return fetch(new URL(`/api/${protocol}`, server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Feed-Api-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: protocol, ...envelope }),
    });
  }

  async function statuses(key: string) {
    return {
      mcp: (await call('mcp', key)).status,
      a2a: (await call('a2a', key)).status,
    };
  }

  test(deletionCase, async () => {
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values(
          [owner, control].map((id) => ({ id, username: id, updatedAt: now }))
        );
      await tx.insert(userApiKeys).values([
        {
          id: 'deleted-key-active',
          userId: owner,
          keyHash: hashApiKey(ownerKey),
        },
        {
          id: 'deleted-key-old',
          userId: owner,
          keyHash: hashApiKey(generateApiKey()),
          revokedAt: earlierRevocation,
        },
        {
          id: 'deleted-key-control',
          userId: control,
          keyHash: hashApiKey(controlKey),
        },
      ]);
    });

    // Both keys work before the deletion, and the owner's key is now cached.
    expect(await statuses(ownerKey)).toEqual({ mcp: 200, a2a: 200 });
    expect(await statuses(controlKey)).toEqual({ mcp: 200, a2a: 200 });
    expect(await validateUserApiKey(ownerKey)).toEqual({ userId: owner });

    const response = await deleteAccount(
      new NextRequest('http://deleted-key.test/api/users/delete-account', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dev-user-id': owner },
        body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
      })
    );
    expect(response.status).toBe(200);

    // The cached entry is dropped as part of the deletion.
    const cached = await validateUserApiKey(ownerKey);
    const afterDeletion = await statuses(ownerKey);
    // And the stored row no longer validates once the cache is cold.
    clearApiKeyCache();
    const stored = await validateUserApiKey(ownerKey);
    const keys = await db
      .select({ id: userApiKeys.id, revokedAt: userApiKeys.revokedAt })
      .from(userApiKeys)
      .where(inArray(userApiKeys.userId, [owner, control]))
      .orderBy(userApiKeys.id);
    console.log(
      `DELETED_ACCOUNT_KEY cached=${JSON.stringify(cached)} stored=${JSON.stringify(stored)} mcp=${afterDeletion.mcp} a2a=${afterDeletion.a2a} revoked=${JSON.stringify(
        keys.filter((key) => key.revokedAt).map((key) => key.id)
      )}`
    );

    expect(cached).toBeNull();
    expect(stored).toBeNull();
    expect(afterDeletion).toEqual({ mcp: 401, a2a: 401 });
    expect(
      await db.select({ id: users.id }).from(users).where(eq(users.id, owner))
    ).toEqual([]);
    expect(keys.map((key) => key.id)).toEqual([
      'deleted-key-active',
      'deleted-key-control',
      'deleted-key-old',
    ]);
    expect(keys[0]?.revokedAt).toBeInstanceOf(Date);
    // A key revoked earlier keeps its original revocation time.
    expect(keys[2]?.revokedAt?.toISOString()).toBe(
      earlierRevocation.toISOString()
    );
    // Another account's key is untouched and keeps working.
    expect(keys[1]?.revokedAt).toBeNull();
    expect(await statuses(controlKey)).toEqual({ mcp: 200, a2a: 200 });
  });
}

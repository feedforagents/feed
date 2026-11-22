/** PRD §§9.4/12, MVP Phases 5/6: leaderboard rows follow retained profile edits. */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const CASE =
  'refreshes both boards after identity writes from web, MCP and A2A';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET ||= crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { db, eq, inArray, profileUpdateLogs, userApiKeys, users } =
    await import('@feed/db');
  const { generateApiKey, getCache, hashApiKey, setCache } = await import(
    '@feed/api'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { SignJWT } = await import('jose');
  const { NextRequest } = await import('next/server');
  const { POST: updateProfile } = await import(
    '../../../apps/web/src/app/api/users/[userId]/update-profile/route'
  );
  const { GET: leaderboard } = await import(
    '../../../apps/web/src/app/api/leaderboard/route'
  );
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');

  afterAll(() => db.$disconnect());

  test(CASE, async () => {
    const [ownerId, viewerId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
    ]);
    const ownedIds: string[] = [];
    const original = {
      username: `before${ownerId}`,
      displayName: 'Old name',
      profileImageUrl: 'https://example.com/old.png',
    };
    const peer = {
      username: `peer${viewerId}`,
      displayName: 'Unrelated viewer',
      profileImageUrl: 'https://example.com/peer.png',
    };
    const apiKey = generateApiKey();
    const apiKeyId = await generateSnowflakeId();
    let ownedKeyId: string | undefined;
    try {
      const identities = await db
        .insert(users)
        .values(
          [
            { id: ownerId, ...original, reputationPoints: 1000 },
            { id: viewerId, ...peer, reputationPoints: 500 },
          ].map((user) => ({
            ...user,
            stewardId: `f41-${user.id}`,
            updatedAt: new Date(),
            pointsAwardedForProfile: true,
          }))
        )
        .returning({ id: users.id });
      ownedIds.push(...identities.map(({ id }) => id));
      const [key] = await db
        .insert(userApiKeys)
        .values({ id: apiKeyId, userId: ownerId, keyHash: hashApiKey(apiKey) })
        .returning({ id: userApiKeys.id });
      ownedKeyId = key?.id;

      const secret = new TextEncoder().encode(process.env.STEWARD_JWT_SECRET);
      async function sign(id: string) {
        return new SignJWT({ userId: `f41-${id}` })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('steward')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(secret);
      }
      const [writer, reader] = await Promise.all([
        sign(ownerId),
        sign(viewerId),
      ]);
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const req = new NextRequest(request);
          switch (req.nextUrl.pathname) {
            case '/api/leaderboard':
              return leaderboard(req);
            case '/api/profile':
              return updateProfile(req, {
                params: Promise.resolve({ userId: ownerId }),
              });
            case '/api/mcp':
              return mcp(req);
            case '/api/a2a':
              return a2a(req);
            default:
              return new Response(null, { status: 404 });
          }
        },
      });

      type Identity = {
        username: string;
        displayName: string;
        profileImageUrl: string | null;
      };
      async function readBoards(identity: Identity, cache: 'hit' | 'miss') {
        for (const metric of ['trading', 'reputation']) {
          for (const pageSize of [2, 100]) {
            const response = await fetch(
              new URL(
                `api/leaderboard?metric=${metric}&pageSize=${pageSize}&userId=${ownerId}`,
                server.url
              ),
              { headers: { Authorization: `Bearer ${reader}` } }
            );
            expect(response.status).toBe(200);
            expect(response.headers.get('x-cache')).toBe(
              `leaderboard-${cache}`
            );
            expect(response.headers.get('cache-control')).toBe(
              'private, no-store'
            );
            const result: {
              leaderboard: Array<Identity & { id: string }>;
              currentUser: { entry: Identity };
            } = await response.json();
            expect(
              result.leaderboard.find(({ id }) => id === ownerId)
            ).toMatchObject(identity);
            expect(result.currentUser.entry).toMatchObject(identity);
            expect(
              result.leaderboard.find(({ id }) => id === viewerId)
            ).toMatchObject(peer);
          }
        }
      }
      async function post(
        path: string,
        body: Record<string, number | object | string>,
        auth: Record<string, string>
      ) {
        const response = await fetch(new URL(path, server.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      }
      try {
        await readBoards(original, 'miss');
        await readBoards(original, 'hit');
        await setCache('sentinel', 'owned', { namespace: 'leaderboard-proof' });
        const webAuth = { Authorization: `Bearer ${writer}` };
        await post('api/profile', { bio: 'Only the bio changed' }, webAuth);
        await post('api/profile', { ...original }, webAuth);
        await readBoards(original, 'hit');

        const withRemovedAvatar = { ...original, profileImageUrl: null };
        await post('api/profile', { profileImageUrl: '' }, webAuth);
        await readBoards(withRemovedAvatar, 'miss');

        const renamed = { ...withRemovedAvatar, username: `after${ownerId}` };
        const mcpReply = await post(
          'api/mcp',
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'update_profile',
              arguments: { username: renamed.username },
            },
          },
          { 'X-Feed-Api-Key': apiKey, Accept: 'application/json' }
        );
        expect(mcpReply.error).toBeUndefined();
        expect(mcpReply.result?.isError).not.toBe(true);
        await readBoards(renamed, 'miss');

        const renamedAgain = { ...renamed, displayName: 'Agent name' };
        const a2aReply = await post(
          'api/a2a',
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'message/send',
            params: {
              message: {
                kind: 'message',
                role: 'user',
                messageId: crypto.randomUUID(),
                contextId: ownerId,
                parts: [
                  {
                    kind: 'data',
                    data: {
                      operation: 'users.update_profile',
                      params: { displayName: renamedAgain.displayName },
                    },
                  },
                ],
              },
            },
          },
          { 'X-Feed-Api-Key': apiKey }
        );
        expect(a2aReply.error).toBeUndefined();
        await readBoards(renamedAgain, 'miss');
        expect(
          await getCache<string>('sentinel', { namespace: 'leaderboard-proof' })
        ).toBe('owned');
      } finally {
        server.stop(true);
      }
    } finally {
      if (ownedKeyId) {
        await db.delete(userApiKeys).where(eq(userApiKeys.id, ownedKeyId));
      }
      if (ownedIds.length > 0) {
        const logs = await db
          .select({ id: profileUpdateLogs.id })
          .from(profileUpdateLogs)
          .where(inArray(profileUpdateLogs.userId, ownedIds));
        if (logs.length > 0) {
          await db.delete(profileUpdateLogs).where(
            inArray(
              profileUpdateLogs.id,
              logs.map(({ id }) => id)
            )
          );
        }
        await db.delete(users).where(inArray(users.id, ownedIds));
      }
    }
  });
} else {
  test('checks leaderboard identity in a disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'leaderboard-profile-identity',
      file: 'packages/testing/integration/leaderboard-rename-propagation.integration.test.ts',
      cases: [CASE],
    });
  }, 30000);
}

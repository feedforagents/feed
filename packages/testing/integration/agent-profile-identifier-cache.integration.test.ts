/**
 * PRD sections 8.1/12, MVP Phases 3/5: a profile edit made through MCP or A2A
 * must refresh the cached identifier lookups that public profile reads use,
 * exactly as the website profile update route does.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const CASE =
  'refreshes cached profile lookups after MCP and A2A profile updates';

if (process.env.FEED_SUB_MARKET_CHILD) {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET ||= crypto.randomUUID();
  mock.module('server-only', () => ({}));

  const { db, eq, inArray, profileUpdateLogs, userApiKeys, users } =
    await import('@feed/db');
  const { generateApiKey, hashApiKey } = await import('@feed/api');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET: profile } = await import(
    '../../../apps/web/src/app/api/users/[userId]/profile/route'
  );
  const { GET: resolveProfile } = await import(
    '../../../apps/web/src/app/api/profiles/resolve/[identifier]/route'
  );
  const { POST: mcp } = await import('../../../apps/web/src/app/api/mcp/route');
  const { POST: a2a } = await import('../../../apps/web/src/app/api/a2a/route');

  afterAll(() => db.$disconnect());

  test(CASE, async () => {
    const ownerId = await generateSnowflakeId();
    const ownedIds: string[] = [];
    const original = {
      username: `agentold${ownerId}`,
      displayName: 'Original agent',
      bio: 'Original bio',
    };
    const mcpName = `agentmcp${ownerId}`;
    const a2aName = `agenta2a${ownerId}`;
    const apiKey = generateApiKey();
    const apiKeyId = await generateSnowflakeId();
    let ownedKeyId: string | undefined;
    try {
      const inserted = await db
        .insert(users)
        .values({
          id: ownerId,
          ...original,
          stewardId: `f42-${ownerId}`,
          updatedAt: new Date(),
          pointsAwardedForProfile: true,
        })
        .returning({ id: users.id });
      ownedIds.push(...inserted.map(({ id }) => id));
      const [key] = await db
        .insert(userApiKeys)
        .values({ id: apiKeyId, userId: ownerId, keyHash: hashApiKey(apiKey) })
        .returning({ id: userApiKeys.id });
      ownedKeyId = key?.id;

      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          const req = new NextRequest(request);
          const path = req.nextUrl.pathname;
          if (path.startsWith('/api/profile/')) {
            const userId = decodeURIComponent(
              path.slice('/api/profile/'.length)
            );
            return profile(req, { params: Promise.resolve({ userId }) });
          }
          if (path.startsWith('/api/resolve/')) {
            const identifier = decodeURIComponent(
              path.slice('/api/resolve/'.length)
            );
            return resolveProfile(req, {
              params: Promise.resolve({ identifier }),
            });
          }
          if (path === '/api/mcp') return mcp(req);
          if (path === '/api/a2a') return a2a(req);
          return new Response(null, { status: 404 });
        },
      });

      type ProfileView = {
        id: string;
        username: string | null;
        displayName: string | null;
        bio: string | null;
      } | null;
      async function readProfile(identifier: string): Promise<ProfileView> {
        const response = await fetch(
          new URL(`api/profile/${encodeURIComponent(identifier)}`, server.url)
        );
        expect(response.status).toBe(200);
        const body: { user: ProfileView } = await response.json();
        return body.user;
      }
      async function resolve(identifier: string) {
        const response = await fetch(
          new URL(`api/resolve/${encodeURIComponent(identifier)}`, server.url)
        );
        return {
          status: response.status,
          body: (await response.json()) as { redirect?: string },
        };
      }
      async function post(
        path: string,
        body: Record<string, number | object | string>
      ) {
        const response = await fetch(new URL(path, server.url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Feed-Api-Key': apiKey,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return response.json();
      }

      // Warm every lookup a profile visitor can hit: by id, by the current
      // handle, and the not-yet-taken handles (cached as "not found").
      async function warm(oldName: string, newName: string) {
        await readProfile(ownerId);
        await readProfile(oldName);
        await readProfile(newName);
        await resolve(oldName);
        await resolve(newName);
      }

      const stale: string[] = [];
      async function check(
        surface: string,
        oldName: string,
        expected: { username: string; displayName: string; bio: string }
      ) {
        const byId = await readProfile(ownerId);
        if (
          byId?.username !== expected.username ||
          byId?.displayName !== expected.displayName ||
          byId?.bio !== expected.bio
        ) {
          stale.push(`${surface}: profile by id`);
        }
        const byNewName = await readProfile(expected.username);
        if (byNewName?.id !== ownerId) {
          stale.push(`${surface}: profile by new handle`);
        }
        const byOldName = await readProfile(oldName);
        if (byOldName !== null) {
          stale.push(`${surface}: profile by released handle`);
        }
        const resolvedNew = await resolve(expected.username);
        if (resolvedNew.body.redirect !== `/u/${expected.username}`) {
          stale.push(`${surface}: resolve new handle`);
        }
        const resolvedOld = await resolve(oldName);
        if (resolvedOld.body.redirect !== undefined) {
          stale.push(`${surface}: resolve released handle`);
        }
      }

      try {
        await warm(original.username, mcpName);
        const mcpReply = await post('api/mcp', {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'update_profile',
            arguments: {
              username: mcpName,
              displayName: 'MCP agent',
              bio: 'Bio from MCP',
            },
          },
        });
        expect(mcpReply.error).toBeUndefined();
        expect(mcpReply.result?.isError).not.toBe(true);
        await check('mcp', original.username, {
          username: mcpName,
          displayName: 'MCP agent',
          bio: 'Bio from MCP',
        });

        await warm(mcpName, a2aName);
        const a2aReply = await post('api/a2a', {
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
                    params: {
                      username: a2aName,
                      displayName: 'A2A agent',
                      bio: 'Bio from A2A',
                    },
                  },
                },
              ],
            },
          },
        });
        expect(a2aReply.error).toBeUndefined();
        await check('a2a', mcpName, {
          username: a2aName,
          displayName: 'A2A agent',
          bio: 'Bio from A2A',
        });

        // A bio-only edit keeps the handle but must still refresh the
        // cached profile row.
        await readProfile(ownerId);
        const bioReply = await post('api/mcp', {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'update_profile',
            arguments: { bio: 'Second MCP bio' },
          },
        });
        expect(bioReply.result?.isError).not.toBe(true);
        if ((await readProfile(ownerId))?.bio !== 'Second MCP bio') {
          stale.push('mcp: bio-only profile by id');
        }

        console.log(
          stale.length === 0
            ? 'AGENT_PROFILE_CACHE_OK'
            : `AGENT_PROFILE_CACHE_STALE ${stale.join('; ')}`
        );
        expect(stale).toEqual([]);
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
  test('checks agent profile lookups in a disposable database', async () => {
    await runIsolatedSubMarketCases({
      name: 'agent-profile-identifier-cache',
      file: 'packages/testing/integration/agent-profile-identifier-cache.integration.test.ts',
      cases: [CASE],
    });
  }, 30000);
}

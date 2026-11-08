/**
 * GET /api/users/search against a real database: test accounts must not
 * appear in web people search.
 *
 * Sibling discovery surfaces already exclude test accounts: the main feed
 * drops test authors in SQL before paginating (DatabaseService
 * .getRecentPosts: author id NOT LIKE 'test-%' and author isTest = false),
 * and getPostsByActor returns nothing for a test user, where a test user is
 * `users.isTest = true` OR an id starting with 'test-'. The leaderboard fix
 * (#1692) applied the same membership rule to the wallet board. The search
 * route already excludes actors, agents, and banned users, but not test
 * accounts, so they surface in mention autocomplete, DM recipient picking,
 * and group member search, and they consume slots of the 20-result cap.
 *
 * The route is exercised unmodified, imported directly (the pattern used by
 * comment-detail-moderation.integration.test.ts). Auth uses the dev
 * x-dev-user-id bypass (NODE_ENV=test) with a seeded viewer row, and rate
 * limiting is disabled through the supported test switch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

process.env.DISABLE_RATE_LIMITING = 'true';

type SearchResponse = {
  users: Array<{ id: string; username: string }>;
};

let GET: typeof import('../../../apps/web/src/app/api/users/search/route').GET;

let viewerId: string;
let realAId: string;
let realBId: string;
let testFlaggedId: string;
let testPrefixedId: string;
let bannedId: string;
let actorId: string;
let agentId: string;
let token: string;
const ownedIds: string[] = [];

async function search(q: string, extra = ''): Promise<SearchResponse> {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/search?q=${q}${extra}`, {
      headers: { 'x-dev-user-id': viewerId },
    })
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResponse;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/users/search/route'));

  const suffix = (await generateSnowflakeId()).slice(-10);
  token = `zzg${suffix}`;
  viewerId = await generateSnowflakeId();
  realAId = await generateSnowflakeId();
  realBId = await generateSnowflakeId();
  testFlaggedId = await generateSnowflakeId();
  testPrefixedId = `test-${await generateSnowflakeId()}`;
  bannedId = await generateSnowflakeId();
  actorId = await generateSnowflakeId();
  agentId = await generateSnowflakeId();
  ownedIds.push(
    viewerId,
    realAId,
    realBId,
    testFlaggedId,
    testPrefixedId,
    bannedId,
    actorId,
    agentId
  );

  const now = new Date();
  await db.insert(users).values([
    { id: viewerId, username: `viewer${suffix}`, updatedAt: now },
    { id: realAId, username: `${token}alice`, updatedAt: now },
    { id: realBId, username: `${token}alina`, updatedAt: now },
    {
      id: testFlaggedId,
      username: `${token}testflag`,
      isTest: true,
      updatedAt: now,
    },
    { id: testPrefixedId, username: `${token}testprefix`, updatedAt: now },
    {
      id: bannedId,
      username: `${token}banned`,
      isBanned: true,
      updatedAt: now,
    },
    { id: actorId, username: `${token}actor`, isActor: true, updatedAt: now },
    { id: agentId, username: `${token}agent`, isAgent: true, updatedAt: now },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ownedIds));
});

describe('web people search membership', () => {
  it('lists only real people: test accounts never appear', async () => {
    const { users: found } = await search(token);
    const ids = found.map((u) => u.id);
    expect(ids).toContain(realAId);
    expect(ids).toContain(realBId);
    expect(ids).not.toContain(testFlaggedId);
    expect(ids).not.toContain(testPrefixedId);
    // Controls that already pass on base: banned, actor, agent stay out.
    expect(ids).not.toContain(bannedId);
    expect(ids).not.toContain(actorId);
    expect(ids).not.toContain(agentId);
    // The result count itself must not be inflated by hidden accounts.
    expect(found.length).toBe(2);
  });

  it('does not return a test account even on an exact username match', async () => {
    const { users: found } = await search(`${token}testflag`);
    expect(found.map((u) => u.id)).not.toContain(testFlaggedId);
    expect(found.length).toBe(0);
  });

  it('still excludes test accounts when agents are included', async () => {
    const { users: found } = await search(token, '&includeAgents=true');
    const ids = found.map((u) => u.id);
    expect(ids).toContain(agentId);
    expect(ids).toContain(realAId);
    expect(ids).not.toContain(testFlaggedId);
    expect(ids).not.toContain(testPrefixedId);
    expect(found.length).toBe(3);
  });
});

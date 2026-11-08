/**
 * GET /api/registry (the public user/agent directory) against a real
 * database: the directory must list only the accounts a visitor can treat
 * as real members — test and banned accounts must not appear in the list
 * or in `pagination.total`.
 *
 * The route documents itself as the public directory for "User discovery
 * and networking / Community member browsing / Agent/user directory" and
 * currently builds its where clause as `{}`, so every row in the users
 * table is returned and counted. Its payload does not carry isTest or
 * isBanned (only isActor), so no consumer can filter the hidden tiers
 * out client-side either.
 *
 * Every sibling discovery surface applies one membership rule in the
 * query itself:
 * - web people search (GET /api/users/search) excludes banned users in
 *   its base filters, and #1695 adds isTest = false plus
 *   NOT id LIKE 'test-%' (the test-account definition DatabaseService
 *   .getRecentPosts already uses: isTest set OR an id starting 'test-');
 * - the wallet reputation leaderboard (#1692) excludes isTest and
 *   isBanned accounts from the list, its totalCount, and rank lookups;
 * - profile follow lists and counts (#1697) apply the same rule;
 * - the A2A people search (#1675) applies isTest/isBanned = false.
 *
 * The one route that deliberately returns every registered user is the
 * sibling GET /api/registry/all: it serves the admin registry panel,
 * whose Ban/Unban actions need banned users present, and #1706 keeps
 * that route unfiltered and filters in the explore autocomplete
 * consumer instead — a consumer that receives isTest/isBanned in its
 * payload. /api/registry has no admin consumer (nothing in the repo
 * fetches it except a shape-only endpoint test) and no payload flags,
 * so the exclusion belongs in this route's shared where clause, which
 * feeds both the list query and the count query.
 *
 * Actors and agents are NOT hidden tiers here: this directory's own
 * contract is "all registered users and agents", its payload exposes
 * isActor, and its use cases include the agent directory — fixtures
 * assert they stay listed.
 *
 * The route is exercised unmodified, imported directly. It is a public
 * route (publicRateLimit only), so no auth header is needed; rate
 * limiting is disabled through the supported test switch. This dedicated
 * database starts empty, so `pagination.total` is asserted against the
 * exact visible population.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

process.env.DISABLE_RATE_LIMITING = 'true';

type RegistryBody = {
  users: Array<{ id: string; username: string | null; isActor: boolean }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
};

let GET: typeof import('../../../apps/web/src/app/api/registry/route').GET;

async function fetchRegistry(qs: string): Promise<RegistryBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/registry?${qs}`)
  );
  const response = await GET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as RegistryBody;
}

let normalAId: string;
let normalBId: string;
let testFlagId: string;
let testPrefixId: string;
let bannedId: string;
let actorId: string;
let agentId: string;

const ownedIds: string[] = [];
const hiddenIds = () => [testFlagId, testPrefixId, bannedId];
const visibleIds = () => [normalAId, normalBId, actorId, agentId];

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/registry/route'));

  const raw = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  [normalAId, normalBId, testFlagId, bannedId, actorId, agentId] = raw as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  testPrefixId = `test-g32${raw[0]?.slice(-8)}`;
  ownedIds.push(...raw, testPrefixId);

  const now = new Date();
  await db.insert(users).values([
    { id: normalAId, username: `g32reg-normal-a`, updatedAt: now },
    { id: normalBId, username: `g32reg-normal-b`, updatedAt: now },
    {
      id: testFlagId,
      username: `g32reg-testflag`,
      isTest: true,
      updatedAt: now,
    },
    {
      // No isTest flag: the 'test-' id prefix alone marks a test account
      // (DatabaseService.getPostsByActor / getRecentPosts definition).
      id: testPrefixId,
      username: `g32reg-testprefix`,
      updatedAt: now,
    },
    {
      id: bannedId,
      username: `g32reg-banned`,
      isBanned: true,
      updatedAt: now,
    },
    { id: actorId, username: `g32reg-actor`, isActor: true, updatedAt: now },
    { id: agentId, username: `g32reg-agent`, isAgent: true, updatedAt: now },
  ]);

  // Fixture sanity: the rows really carry the tiers the tests rely on.
  const rows = await db
    .select({
      id: users.id,
      isTest: users.isTest,
      isBanned: users.isBanned,
      isActor: users.isActor,
      isAgent: users.isAgent,
    })
    .from(users)
    .where(inArray(users.id, ownedIds));
  expect(rows.length).toBe(7);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(testFlagId)?.isTest).toBe(true);
  expect(byId.get(testPrefixId)?.isTest).toBe(false);
  expect(byId.get(bannedId)?.isBanned).toBe(true);
  expect(byId.get(actorId)?.isActor).toBe(true);
  expect(byId.get(agentId)?.isAgent).toBe(true);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ownedIds));
});

describe('GET /api/registry — directory membership', () => {
  it('lists real members, actors and agents, but no test or banned accounts', async () => {
    const body = await fetchRegistry('limit=100&offset=0');
    const ids = body.users.map((u) => u.id);
    for (const id of visibleIds()) expect(ids).toContain(id);
    for (const id of hiddenIds()) expect(ids).not.toContain(id);
  });

  it('counts only visible members in pagination.total', async () => {
    const body = await fetchRegistry('limit=100&offset=0');
    // This database holds exactly the seven fixtures: four visible
    // members and three hidden-tier accounts.
    expect(body.pagination.total).toBe(4);
    expect(body.users.length).toBe(4);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('hidden accounts stay out when paging through the whole directory', async () => {
    // Page on the unique username key so this traversal measures the
    // membership axis only; ordering ties on the other sort keys are
    // #1720's axis, not this one.
    const ids: string[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const body = await fetchRegistry(
        `sortBy=username&sortOrder=asc&limit=2&offset=${offset}`
      );
      ids.push(...body.users.map((u) => u.id));
      if (!body.pagination.hasMore) break;
      offset += 2;
    }
    expect(new Set(ids).size).toBe(4);
    for (const id of visibleIds()) expect(ids).toContain(id);
    for (const id of hiddenIds()) expect(ids).not.toContain(id);
  });
});

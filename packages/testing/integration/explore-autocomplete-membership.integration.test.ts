/**
 * Explore autocomplete membership (registry-backed) integration tests.
 *
 * The explore/sidebar search box (EntitySearchAutocomplete) builds its
 * suggestions from GET /api/registry/all. That route is shared with the
 * admin registry panel, which must keep seeing every registered user (it
 * renders Banned badges and the Ban/Unban actions), so membership filtering
 * belongs to the autocomplete layer — the same layer that already drops
 * NPC users (isActor) from the suggestions.
 *
 * For the autocomplete to drop test and banned accounts it needs the
 * membership flags on the payload. isBanned was already exposed; isTest
 * was not, so an account flagged as a test account (users.isTest = true)
 * with an ordinary id could not be told apart from a real person by the
 * client at all.
 *
 * Membership rule (the one the sibling discovery surfaces apply — see
 * DatabaseService.getRecentPosts and the people-search fix): a test
 * account is `users.isTest = true` OR an id starting with 'test-'; banned
 * accounts (isBanned = true) are not real, discoverable people either.
 *
 * The route is exercised unmodified, imported directly, against a real
 * database. The suggestion-building half of the behavior is covered by
 * the unit test next to the component
 * (apps/web/src/components/explore/EntitySearchAutocomplete.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type RegistryUser = {
  id: string;
  username: string | null;
  isActor: boolean;
  isBanned: boolean;
  isTest?: boolean;
};

type RegistryResponse = {
  users: RegistryUser[];
  totals: { users: number };
};

const token = Math.random().toString(36).slice(2, 8);
const searchTerm = `g31${token}`;

let normalId: string;
let testFlaggedId: string;
let testPrefixedId: string;
let bannedId: string;
let actorId: string;
const allUserIds: string[] = [];

let registryGET: typeof import('../../../apps/web/src/app/api/registry/all/route').GET;

async function fetchRegistryUsers(search: string): Promise<RegistryResponse> {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/registry/all?type=users&search=${encodeURIComponent(search)}`
    )
  );
  const response = await registryGET(request);
  expect(response.status).toBe(200);
  return (await response.json()) as RegistryResponse;
}

beforeAll(async () => {
  ({ GET: registryGET } = await import(
    '../../../apps/web/src/app/api/registry/all/route'
  ));

  const [nId, tId, bId, aId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  normalId = nId;
  testFlaggedId = tId;
  bannedId = bId;
  actorId = aId;
  testPrefixedId = `test-g31-${await generateSnowflakeId()}`;
  allUserIds.push(normalId, testFlaggedId, testPrefixedId, bannedId, actorId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: normalId,
      username: `${searchTerm}person`,
      displayName: 'G31 Normal Person',
      updatedAt: now,
    },
    {
      id: testFlaggedId,
      username: `${searchTerm}testflag`,
      displayName: 'G31 Test Flagged',
      isTest: true,
      updatedAt: now,
    },
    {
      id: testPrefixedId,
      username: `${searchTerm}testprefix`,
      displayName: 'G31 Test Prefix',
      updatedAt: now,
    },
    {
      id: bannedId,
      username: `${searchTerm}banned`,
      displayName: 'G31 Banned User',
      isBanned: true,
      updatedAt: now,
    },
    {
      id: actorId,
      username: `${searchTerm}actor`,
      displayName: 'G31 Actor User',
      isActor: true,
      updatedAt: now,
    },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/registry/all — explore autocomplete membership data', () => {
  it('returns every fixture user for the admin registry panel (no route-level filtering)', async () => {
    const body = await fetchRegistryUsers(searchTerm);
    const ids = body.users.map((u) => u.id);
    expect(ids).toContain(normalId);
    expect(ids).toContain(testFlaggedId);
    expect(ids).toContain(testPrefixedId);
    expect(ids).toContain(bannedId);
    expect(ids).toContain(actorId);
  });

  it('exposes the isTest flag so the autocomplete can drop test accounts', async () => {
    const body = await fetchRegistryUsers(searchTerm);
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.get(testFlaggedId)?.isTest).toBe(true);
    expect(byId.get(normalId)?.isTest).toBe(false);
    expect(byId.get(bannedId)?.isTest).toBe(false);
  });

  it('exposes the isBanned flag used by the autocomplete filter', async () => {
    const body = await fetchRegistryUsers(searchTerm);
    const byId = new Map(body.users.map((u) => [u.id, u]));
    expect(byId.get(bannedId)?.isBanned).toBe(true);
    expect(byId.get(normalId)?.isBanned).toBe(false);
  });
});

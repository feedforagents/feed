/**
 * Profile follow lists against a real database: the followers and following
 * lists on a web profile must show only real, visible accounts.
 *
 * Every sibling discovery surface already hides the non-player account
 * tiers: the main feed excludes test authors in SQL (DatabaseService
 * .getRecentPosts: `isTest` flag or an id starting with 'test-'), the
 * following feed filters test users out of the followed set
 * (CachedDatabaseService.getPostsForFollowing), and web people search
 * excludes banned accounts by default (`isBanned: false`). The follow
 * lists filtered nothing: a test account (flagged or 'test-' prefixed)
 * or a banned account that held a follow edge appeared in the list, and
 * the header stats counted the same hidden edges, so the counts on the
 * profile screen measured accounts the rest of the product hides.
 *
 * The profile stats code states the agreement rule for its own counts:
 * the followers list and the profile count must use the same membership
 * or they disagree on the same profile screen. These tests pin that
 * agreement for the hidden-account tiers across the list routes, the
 * by-username header stats, and CachedDatabaseService profile stats.
 *
 * Fixture ownership: every helper records an ID only from the successful
 * `returning()` result of its own insert. Teardown deletes exactly the
 * recorded IDs, so a setup failure on a conflicting ID can never delete
 * a row this run did not create; rows inserted before a later setup
 * failure are still recorded and are cleaned up. The NPC target is
 * chosen at runtime (see the NPC test) instead of assuming a fixed
 * registry actor, and NPC assertions compare owned membership and a
 * captured count baseline rather than the shared actor's whole list.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  cachedDb,
  findTargetByIdentifier,
  findUserByIdentifier,
} from '@feed/api';
import {
  db,
  eq,
  followStatuses,
  follows,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ListEntry = { id: string; isActor: boolean; viewerFollows?: boolean };
type ListBody = {
  followers?: ListEntry[];
  following?: ListEntry[];
  count: number;
  hasMore: boolean;
};

let GET_FOLLOWERS: typeof import('../../../apps/web/src/app/api/users/[userId]/followers/route').GET;
let GET_FOLLOWING: typeof import('../../../apps/web/src/app/api/users/[userId]/following/route').GET;
let GET_BY_USERNAME: typeof import('../../../apps/web/src/app/api/users/by-username/[username]/route').GET;

let targetId: string;
let targetUsername: string;
let pageTargetId: string;
let normalA: string;
let normalB: string;
let normalC: string;
let testFlagged: string;
let testPrefixed: string;
let banned: string;
let viewerId: string;
let viewerToken: string;
let npcActorId: string;
let npcBaselineCount: number;
let npcBranchWasActor: boolean;
let npcCanonicalTargetId: string | null;
let npcFollowerId: string;

// Owned IDs, recorded only from successful insert results (see header).
const ownedUserIds: string[] = [];
const ownedFollowIds: string[] = [];
const ownedUserActorFollowIds: string[] = [];
const ownedFollowStatusIds: string[] = [];

async function callList(
  kind: 'followers' | 'following',
  userId: string,
  options: { page?: number; limit?: number; token?: string } = {}
): Promise<ListBody> {
  const handler = kind === 'followers' ? GET_FOLLOWERS : GET_FOLLOWING;
  const query = new URLSearchParams();
  if (options.page !== undefined) query.set('page', String(options.page));
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/${kind}${suffix}`, {
      headers: options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {},
    })
  );
  const response = await handler(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ListBody;
}

async function insertUser(
  id: string,
  label: string,
  flags: { isTest?: boolean; isBanned?: boolean; stewardId?: string } = {}
) {
  const [row] = await db
    .insert(users)
    .values({
      id,
      username: `g19${label}-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`,
      displayName: `G19 ${label}`,
      isTest: flags.isTest ?? false,
      isBanned: flags.isBanned ?? false,
      stewardId: flags.stewardId,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!row) throw new Error(`user insert returned no row for ${label}`);
  ownedUserIds.push(row.id);
  return row.id;
}

async function insertFollow(
  followerId: string,
  followingId: string,
  createdAt: Date
) {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(follows)
    .values({ id, followerId, followingId, createdAt })
    .returning({ id: follows.id });
  if (!row) throw new Error('follow insert returned no row');
  ownedFollowIds.push(row.id);
  return row.id;
}

async function insertUserActorFollow(
  userId: string,
  actorId: string,
  createdAt: Date
) {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(userActorFollows)
    .values({ id, userId, actorId, createdAt })
    .returning({ id: userActorFollows.id });
  if (!row) throw new Error('userActorFollow insert returned no row');
  ownedUserActorFollowIds.push(row.id);
  return row.id;
}

async function insertNpcFollowStatus(
  userId: string,
  npcId: string,
  followedAt: Date
) {
  const id = await generateSnowflakeId();
  const [row] = await db
    .insert(followStatuses)
    .values({
      id,
      userId,
      npcId,
      followedAt,
      isActive: true,
      followReason: 'story',
    })
    .returning({ id: followStatuses.id });
  if (!row) throw new Error('followStatus insert returned no row');
  ownedFollowStatusIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  ({ GET: GET_FOLLOWERS } = await import(
    '../../../apps/web/src/app/api/users/[userId]/followers/route'
  ));
  ({ GET: GET_FOLLOWING } = await import(
    '../../../apps/web/src/app/api/users/[userId]/following/route'
  ));
  ({ GET: GET_BY_USERNAME } = await import(
    '../../../apps/web/src/app/api/users/by-username/[username]/route'
  ));

  targetId = await generateSnowflakeId();
  normalA = await generateSnowflakeId();
  normalB = await generateSnowflakeId();
  normalC = await generateSnowflakeId();
  testFlagged = await generateSnowflakeId();
  banned = await generateSnowflakeId();
  testPrefixed = `test-g19-${await generateSnowflakeId()}`;
  viewerId = await generateSnowflakeId();
  targetUsername = `g19target-${targetId.slice(-12)}`;

  await insertUser(targetId, 'target');
  // Rewrite the target username to a known value for the by-username call.
  await db
    .update(users)
    .set({ username: targetUsername })
    .where(eq(users.id, targetId));
  await insertUser(normalA, 'normala');
  await insertUser(normalB, 'normalb');
  await insertUser(normalC, 'normalc');
  await insertUser(testFlagged, 'testflag', { isTest: true });
  await insertUser(testPrefixed, 'testpref');
  await insertUser(banned, 'banned', { isBanned: true });

  // Viewer for the follow-state case: a Steward JWT whose subject is the
  // viewer's stewardId (the pattern sibling signed-viewer tests use).
  await insertUser(viewerId, 'viewer', { stewardId: `g19-${viewerId}` });
  const secret =
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod';
  viewerToken = await new SignJWT({ userId: `g19-${viewerId}` })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  // Followers of the target: three real accounts plus one of each hidden
  // tier. Hidden tiers are the most recent, so an unfiltered list leads
  // with accounts no other surface will show.
  await insertFollow(normalA, targetId, at(60));
  await insertFollow(normalB, targetId, at(50));
  await insertFollow(normalC, targetId, at(45));
  await insertFollow(testFlagged, targetId, at(30));
  await insertFollow(testPrefixed, targetId, at(20));
  await insertFollow(banned, targetId, at(10));

  // The target follows the same tiers (two real, three hidden).
  await insertFollow(targetId, normalA, at(50));
  await insertFollow(targetId, normalB, at(40));
  await insertFollow(targetId, testFlagged, at(30));
  await insertFollow(targetId, testPrefixed, at(20));
  await insertFollow(targetId, banned, at(10));

  // The viewer follows one visible follower of the target (normalA) and
  // does not follow the other visible one used in the assertion (normalB).
  await insertFollow(viewerId, normalA, at(5));

  // --- NPC target -------------------------------------------------------
  // The previous fixture took StaticDataRegistry.getAllActors()[0] and
  // assumed the followers route would take the actor branch for it.
  // findTargetByIdentifier resolves a User row first, so in full-suite
  // order a shared actor whose id or username also resolves as a user
  // takes the user branch and the UserActorFollow edges are never read
  // (the CI failure: expected [normalA], received []). Choose the target
  // at runtime instead: the first registry actor that does not resolve
  // as a user by id or by username right now, and record the resolution
  // the route will see, through the same lookup the route uses.
  let chosenActorId: string | null = null;
  for (const actor of StaticDataRegistry.getAllActors()) {
    const byId = await findUserByIdentifier(actor.id);
    if (byId) continue;
    if (actor.username) {
      const byUsername = await findUserByIdentifier(actor.username);
      if (byUsername) continue;
    }
    chosenActorId = actor.id;
    break;
  }
  if (!chosenActorId) {
    throw new Error('no registry actor resolves cleanly as an actor target');
  }
  npcActorId = chosenActorId;
  const resolution = await findTargetByIdentifier(npcActorId);
  npcBranchWasActor = resolution.isActor;
  npcCanonicalTargetId = resolution.targetId;

  // Baseline: the shared actor's follower total before this fixture adds
  // its edges. Existing relationships are preserved, never cleared.
  const baseline = await callList('followers', npcActorId);
  npcBaselineCount = baseline.count;

  npcFollowerId = normalA;
  await insertUserActorFollow(npcFollowerId, npcActorId, at(30));
  await insertUserActorFollow(testFlagged, npcActorId, at(20));
  await insertUserActorFollow(banned, npcActorId, at(10));

  // --- Page-boundary target --------------------------------------------
  // A second user target whose followers mix humans and NPCs, with the
  // hidden human tiers leading the sort (most recent). Visible order by
  // followedAt desc: npcFollower (25m), normalB (35m), normalA (45m).
  pageTargetId = await generateSnowflakeId();
  await insertUser(pageTargetId, 'pagetarget');
  const npcIds = StaticDataRegistry.getAllActors()
    .map((a) => a.id)
    .filter((id) => id !== npcActorId)
    .slice(0, 1);
  if (npcIds.length === 0) throw new Error('registry has no second actor');
  await insertFollow(banned, pageTargetId, at(5));
  await insertFollow(testFlagged, pageTargetId, at(15));
  await insertNpcFollowStatus(pageTargetId, npcIds[0] as string, at(25));
  await insertFollow(normalB, pageTargetId, at(35));
  await insertFollow(normalA, pageTargetId, at(45));
});

afterAll(async () => {
  if (ownedFollowIds.length > 0) {
    await db.delete(follows).where(inArray(follows.id, ownedFollowIds));
  }
  if (ownedUserActorFollowIds.length > 0) {
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, ownedUserActorFollowIds));
  }
  if (ownedFollowStatusIds.length > 0) {
    await db
      .delete(followStatuses)
      .where(inArray(followStatuses.id, ownedFollowStatusIds));
  }
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('profile follow lists hide test and banned accounts', () => {
  it('followers list shows only real accounts and counts them', async () => {
    const body = await callList('followers', targetId);
    const ids = (body.followers ?? []).map((f) => f.id).sort();
    expect(ids).toEqual([normalA, normalB, normalC].sort());
    expect(body.count).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('following list shows only real accounts and counts them', async () => {
    const body = await callList('following', targetId);
    const ids = (body.following ?? []).map((f) => f.id).sort();
    expect(ids).toEqual([normalA, normalB].sort());
    expect(body.count).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  it('NPC followers list hides test and banned user followers', async () => {
    // The fixture must actually exercise the actor branch of the route.
    expect(npcBranchWasActor).toBe(true);
    expect(npcCanonicalTargetId).toBe(npcActorId);
    const body = await callList('followers', npcActorId);
    // Owned membership only: the shared actor may have other followers
    // from other suites; of this fixture's three UserActorFollow edges,
    // only the real account may appear.
    const fixtureIds = new Set([npcFollowerId, testFlagged, banned]);
    const visibleOwned = (body.followers ?? [])
      .filter((f) => !f.isActor && fixtureIds.has(f.id))
      .map((f) => f.id);
    expect(visibleOwned).toEqual([npcFollowerId]);
    // The route total must grow by exactly the one visible owned edge
    // over the captured baseline.
    expect(body.count).toBe(npcBaselineCount + 1);
  });

  it('hidden followers leading the sort do not underfill pages', async () => {
    const page1 = await callList('followers', pageTargetId, {
      page: 1,
      limit: 2,
    });
    const page1Entries = page1.followers ?? [];
    expect(page1Entries).toHaveLength(2);
    expect(page1Entries[0]?.isActor).toBe(true);
    expect(page1Entries[1]?.id).toBe(normalB);
    expect(page1.count).toBe(3);
    expect(page1.hasMore).toBe(true);

    const page2 = await callList('followers', pageTargetId, {
      page: 2,
      limit: 2,
    });
    const page2Entries = page2.followers ?? [];
    expect(page2Entries).toHaveLength(1);
    expect(page2Entries[0]?.id).toBe(normalA);
    expect(page2.count).toBe(3);
    expect(page2.hasMore).toBe(false);
  });

  it('authenticated viewer sees follow state on visible followers', async () => {
    const body = await callList('followers', targetId, {
      token: viewerToken,
    });
    const entries = new Map(
      (body.followers ?? []).map((f) => [f.id, f] as const)
    );
    expect(entries.get(normalA)?.viewerFollows).toBe(true);
    expect(entries.get(normalB)?.viewerFollows).toBe(false);
    // Hidden tiers stay hidden for a signed viewer too.
    expect(entries.has(testFlagged)).toBe(false);
    expect(entries.has(banned)).toBe(false);
  });

  it('by-username header stats agree with the visible lists', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/users/by-username/${targetUsername}`)
    );
    const response = await GET_BY_USERNAME(request, {
      params: Promise.resolve({ username: targetUsername }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { stats: { followers: number; following: number } };
    };
    expect(body.user.stats.followers).toBe(3);
    expect(body.user.stats.following).toBe(2);
  });

  it('cached profile stats agree with the visible lists', async () => {
    const stats = await cachedDb.getUserProfileStats(targetId);
    expect(stats.followers).toBe(3);
    // Following total adds the target's actor follows (none in this
    // fixture) on top of the visible user follows.
    expect(stats.following).toBe(2);
  });

  it('teardown never deletes a row this run did not create', async () => {
    // A "pre-existing" row, inserted directly (not through the fixture
    // helpers, so this run's ownership records never contain its ID).
    const sentinelFollower = await generateSnowflakeId();
    const sentinelId = await generateSnowflakeId();
    await db.insert(users).values({
      id: sentinelFollower,
      username: `g19sentinel-${sentinelFollower.slice(-12)}`,
      displayName: 'G19 sentinel',
      isTest: false,
      isBanned: false,
      updatedAt: new Date(),
    });
    await db.insert(follows).values({
      id: sentinelId,
      followerId: sentinelFollower,
      followingId: targetId,
      createdAt: new Date(),
    });
    try {
      // A later setup step proposes the same ID and fails on the
      // duplicate key. The failing helper records ownership only from a
      // successful returning(), so it records nothing here.
      let recorded: string | null = null;
      try {
        const [row] = await db
          .insert(follows)
          .values({
            id: sentinelId,
            followerId: normalA,
            followingId: targetId,
            createdAt: new Date(),
          })
          .returning({ id: follows.id });
        recorded = row?.id ?? null;
      } catch {
        recorded = null;
      }
      expect(recorded).toBeNull();
      // Simulate this run's teardown for that helper's records: nothing
      // was recorded, so nothing is deleted for it. The collision row
      // must survive.
      const [survivor] = await db
        .select({ id: follows.id })
        .from(follows)
        .where(eq(follows.id, sentinelId));
      expect(survivor?.id).toBe(sentinelId);
    } finally {
      // The sentinel rows are this test's own direct inserts; removing
      // them here is the test's cleanup of its own rows.
      await db.delete(follows).where(eq(follows.id, sentinelId));
      await db.delete(users).where(eq(users.id, sentinelFollower));
    }
  });
});

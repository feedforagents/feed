/**
 * GET /api/users/[userId]/followers against a real database: an actor (NPC)
 * with more than 200 human followers must report every follower.
 *
 * `count` is documented as the total across all pages and pagination is
 * applied after merging relation sources, so no source may be truncated
 * before the merge. Nothing is mocked: the request is anonymous, the actor
 * comes from the static registry and the follows come from the database.
 *
 * Fixture rows are namespaced by a per-run id and are not deleted.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import {
  actorFollows,
  count,
  db,
  eq,
  followStatuses,
  follows,
  ilike,
  or,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET } from '../route';

type FollowersResponse = {
  followers: Array<{ id: string; isActor: boolean }>;
  count: number;
  hasMore: boolean;
};

const FOLLOWER_COUNT = 201;
const PAGE_SIZE = 100;

let actorId: string;
// Newest first, matching the route's followedAt DESC order.
const followerIds: string[] = [];

/** First registry actor with no user row of the same identifier and no follows. */
async function pickUnfollowedActor(): Promise<string> {
  for (const actor of StaticDataRegistry.getAllActors()) {
    const [userMatch] = await db
      .select({ n: count() })
      .from(users)
      .where(or(eq(users.id, actor.id), ilike(users.username, actor.id)));
    if (userMatch.n > 0) continue;
    const [userFollows] = await db
      .select({ n: count() })
      .from(userActorFollows)
      .where(eq(userActorFollows.actorId, actor.id));
    if (userFollows.n > 0) continue;
    const [npcFollows] = await db
      .select({ n: count() })
      .from(actorFollows)
      .where(eq(actorFollows.followingId, actor.id));
    if (npcFollows.n > 0) continue;
    return actor.id;
  }
  throw new Error(
    'No static actor without existing followers in this database'
  );
}

beforeAll(async () => {
  actorId = await pickUnfollowedActor();
  const runId = await generateSnowflakeId();
  const now = Date.now();

  for (let i = 0; i < FOLLOWER_COUNT; i++) {
    followerIds.push(await generateSnowflakeId());
  }
  await db.insert(users).values(
    followerIds.map((id, i) => ({
      id,
      username: `test-actfol-${runId}-${i}`,
      displayName: 'Actor follower pagination fixture',
      updatedAt: new Date(now),
    }))
  );
  const follows = [];
  for (const [i, userId] of followerIds.entries()) {
    follows.push({
      id: await generateSnowflakeId(),
      userId,
      actorId,
      createdAt: new Date(now - i * 1000),
    });
  }
  await db.insert(userActorFollows).values(follows);
});

async function fetchPage(page: number) {
  const response = await GET(
    new NextRequest(
      `https://feed.example/api/users/${actorId}/followers?page=${page}&limit=${PAGE_SIZE}`
    ),
    { params: Promise.resolve({ userId: actorId }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as FollowersResponse;
}

describe('GET /api/users/[userId]/followers for an actor with >200 followers', () => {
  it('reports every human follower in count and pages', async () => {
    const page1 = await fetchPage(1);
    expect(page1.count).toBe(FOLLOWER_COUNT);
    expect(page1.hasMore).toBe(true);
    expect(page1.followers.map((f) => f.id)).toEqual(
      followerIds.slice(0, PAGE_SIZE)
    );

    const page2 = await fetchPage(2);
    expect(page2.count).toBe(FOLLOWER_COUNT);
    expect(page2.hasMore).toBe(true);
    expect(page2.followers.map((f) => f.id)).toEqual(
      followerIds.slice(PAGE_SIZE, 2 * PAGE_SIZE)
    );

    const page3 = await fetchPage(3);
    expect(page3.count).toBe(FOLLOWER_COUNT);
    expect(page3.hasMore).toBe(false);
    expect(page3.followers.map((f) => f.id)).toEqual(
      followerIds.slice(2 * PAGE_SIZE)
    );

    const all = [...page1.followers, ...page2.followers, ...page3.followers];
    expect(new Set(all.map((f) => f.id))).toEqual(new Set(followerIds));
    expect(all.every((f) => !f.isActor)).toBe(true);
  });
});

async function getFollowers(target: string, query: string) {
  const response = await GET(
    new NextRequest(
      `https://feed.example/api/users/${target}/followers?${query}`
    ),
    { params: Promise.resolve({ userId: target }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as FollowersResponse & {
    followers: Array<{ id: string; isActor: boolean; displayName: string }>;
  };
}

async function insertUser(prefix: string): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `${prefix}-${id}`,
    displayName: `Followers fixture ${prefix}`,
    updatedAt: new Date(),
  });
  return id;
}

describe('GET /api/users/[userId]/followers merged sources (real database)', () => {
  // Actor target.
  let target: string;
  let registryFollower: string;
  let usernameFollower: string;
  let humanOld: string;
  let humanTie: string;
  // User target.
  let userTarget: string;
  let tieA: string;
  let tieB: string;
  let npcKnown: string;
  let npcMissing: string;

  beforeAll(async () => {
    target = await pickUnfollowedActor();
    const others = StaticDataRegistry.getAllActors().filter(
      (a) => a.id !== target && a.username
    );
    const [first, second] = others;
    if (!first || !second?.username) {
      throw new Error('Need two other registry actors with usernames');
    }
    registryFollower = first.id;
    usernameFollower = second.username.toUpperCase();
    const base = Date.now() - 3_600_000;

    humanTie = await insertUser('fmt');
    humanOld = await insertUser('fmo');
    await db.insert(actorFollows).values([
      // Newest, then a tie with a human follower (actor sorts first).
      {
        id: await generateSnowflakeId(),
        followerId: registryFollower,
        followingId: target,
        createdAt: new Date(base),
      },
      {
        id: await generateSnowflakeId(),
        followerId: usernameFollower,
        followingId: target,
        createdAt: new Date(base - 1000),
      },
      // Not in the registry: excluded from page and count.
      {
        id: await generateSnowflakeId(),
        followerId: `missing-${await generateSnowflakeId()}`,
        followingId: target,
        createdAt: new Date(base - 500),
      },
    ]);
    await db.insert(userActorFollows).values([
      {
        id: await generateSnowflakeId(),
        userId: humanTie,
        actorId: target,
        createdAt: new Date(base - 1000),
      },
      {
        id: await generateSnowflakeId(),
        userId: humanOld,
        actorId: target,
        createdAt: new Date(base - 2000),
      },
      // No User row: excluded by the join.
      {
        id: await generateSnowflakeId(),
        userId: await generateSnowflakeId(),
        actorId: target,
        createdAt: new Date(base - 1500),
      },
    ]);

    userTarget = await insertUser('fut');
    tieA = await insertUser('fua');
    tieB = await insertUser('fub');
    npcKnown = registryFollower;
    npcMissing = `missing-npc-${await generateSnowflakeId()}`;
    const followA = await generateSnowflakeId();
    const followB = await generateSnowflakeId();
    await db.insert(follows).values([
      {
        id: followA,
        followerId: tieA,
        followingId: userTarget,
        createdAt: new Date(base),
      },
      {
        id: followB,
        followerId: tieB,
        followingId: userTarget,
        createdAt: new Date(base),
      },
      // No User row: excluded by the join.
      {
        id: await generateSnowflakeId(),
        followerId: await generateSnowflakeId(),
        followingId: userTarget,
        createdAt: new Date(base),
      },
    ]);
    await db.insert(followStatuses).values([
      {
        id: await generateSnowflakeId(),
        userId: userTarget,
        npcId: npcKnown,
        followedAt: new Date(base - 1000),
        isActive: true,
        followReason: 'fixture',
      },
      {
        id: await generateSnowflakeId(),
        userId: userTarget,
        npcId: npcMissing,
        followedAt: new Date(base - 2000),
        isActive: true,
        followReason: 'fixture',
      },
      // Excluded: user_followed, NULL reason, inactive.
      {
        id: await generateSnowflakeId(),
        userId: userTarget,
        npcId: `x1-${followA}`,
        followedAt: new Date(base - 100),
        isActive: true,
        followReason: 'user_followed',
      },
      {
        id: await generateSnowflakeId(),
        userId: userTarget,
        npcId: `x2-${followA}`,
        followedAt: new Date(base - 100),
        isActive: true,
        followReason: null,
      },
      {
        id: await generateSnowflakeId(),
        userId: userTarget,
        npcId: `x3-${followA}`,
        followedAt: new Date(base - 100),
        isActive: false,
        followReason: 'fixture',
      },
    ]);
  });

  it('actor target: registry id/username followers, users, missing actors excluded', async () => {
    const body = await getFollowers(target, 'page=1&limit=10');
    expect(body.count).toBe(4);
    expect(body.hasMore).toBe(false);
    expect(body.followers.map((f) => [f.id, f.isActor])).toEqual([
      [registryFollower, true],
      [usernameFollower, true],
      [humanTie, false],
      [humanOld, false],
    ]);
  });

  it('actor target: limit 1 pages through every follower once', async () => {
    const ids: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const body = await getFollowers(target, `page=${page}&limit=1`);
      expect(body.count).toBe(4);
      expect(body.followers).toHaveLength(1);
      expect(body.hasMore).toBe(page < 4);
      ids.push(...body.followers.map((f) => f.id));
    }
    expect(ids).toEqual([
      registryFollower,
      usernameFollower,
      humanTie,
      humanOld,
    ]);
  });

  it('user target: users, NPC fallback, excluded reasons, deterministic ties', async () => {
    const body = await getFollowers(userTarget, 'page=1&limit=10');
    expect(body.count).toBe(4);
    const ids = body.followers.map((f) => f.id);
    // Equal-time user follows are both present, in a stable order.
    expect(ids.slice(0, 2).sort()).toEqual([tieA, tieB].sort());
    expect(ids.slice(2)).toEqual([npcKnown, npcMissing]);
    expect(body.followers[3]?.displayName).toBe(npcMissing);

    const again = await getFollowers(userTarget, 'page=1&limit=10');
    expect(again.followers.map((f) => f.id)).toEqual(ids);

    const p1 = await getFollowers(userTarget, 'page=1&limit=1');
    const p2 = await getFollowers(userTarget, 'page=2&limit=1');
    expect([...p1.followers, ...p2.followers].map((f) => f.id)).toEqual(
      ids.slice(0, 2)
    );
  });

  it('a page past the end is empty but keeps the total', async () => {
    const body = await getFollowers(userTarget, 'page=50&limit=10');
    expect(body.followers).toEqual([]);
    expect(body.count).toBe(4);
    expect(body.hasMore).toBe(false);
  });
});

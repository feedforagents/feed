/**
 * Organization profile follow lists against a real database.
 *
 * Organization pages are keyed by organization ID (`/orgs/{orgId}`), and the
 * profile client passes that ID to the followers/following list routes. The
 * follow graph itself lives on each organization's shadow actor
 * (`org-{orgId}`): ActorFollow and UserActorFollow rows reference the actor
 * ID, never the organization ID.
 *
 * The list routes must therefore resolve an organization ID to its shadow
 * actor. On the base they only resolve users and actors (by ID or by actor
 * username), so the lists fail with 404 for every organization whose shadow
 * actor's username does not happen to equal the organization ID — while the
 * header stats for some of those same organizations do resolve (via a name
 * fallback) and show the real counts next to a list that will not load.
 *
 * Canonical NPC User rows add a second dispatch hazard: game bootstrap
 * creates a users-table row for every registry actor (id = actor id,
 * isActor = true), and the target lookup finds that row first and reports
 * `actor: null`, so the list routes used to take the human Follow path for
 * shadow actor IDs and return none of the actor's relations. The routes now
 * resolve an isActor target through the static registry (the same treatment
 * as the following-list fix in #1691), and the second describe below covers
 * that dispatch with the canonical row present, plus the no-matching-user
 * path by actor username and an ordinary human control.
 *
 * Nothing is mocked: the real route handlers run against the real database.
 * Assertions are baseline-relative — pre-existing counts and membership are
 * captured before any fixture row is inserted, and each test expects exactly
 * the baseline plus the relations the fixture actually added. Fixture rows
 * are registered only after their INSERT succeeds (RETURNING for users) and
 * only owned rows are removed afterwards; a canonical NPC User row is never
 * deleted, only one the fixture itself created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  actorFollows,
  and,
  db,
  eq,
  follows,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getStats } from '../../../apps/web/src/app/api/actors/[actorId]/stats/route';
import { GET as getFollowers } from '../../../apps/web/src/app/api/users/[userId]/followers/route';
import { GET as getFollowing } from '../../../apps/web/src/app/api/users/[userId]/following/route';

// Organization whose shadow actor username ('amAIzon') differs from the org
// ID, so the list routes cannot resolve it; its stats still resolve through
// the stats route's actor-name fallback (actor name 'AImazon').
const ORG_LIST_BROKEN = 'aimazon';
const ORG_LIST_BROKEN_ACTOR = 'org-aimazon';
// Organization that fails even the stats route's name fallback
// (actor username 'AIrk', actor name does not lowercase to the org ID).
const ORG_ALL_BROKEN = 'airk-invest';
const ORG_ALL_BROKEN_ACTOR = 'org-airk-invest';
// Control organization whose shadow actor username ('teslAI') happens to
// equal the org ID, so every surface already resolves on the base.
const ORG_OK = 'teslai';
const ORG_OK_ACTOR = 'org-teslai';

const ACTOR_FOLLOWER = 'ailon-musk';

let runId: string;
const humanIds: string[] = [];
const actorFollowIds: string[] = [];
const userActorFollowIds: string[] = [];
const followIds: string[] = [];
const createdNpcUserIds: string[] = [];

async function insertHuman(usernameSuffix: string): Promise<string> {
  const [created] = await db
    .insert(users)
    .values({
      id: await generateSnowflakeId(),
      username: `of69-${runId.slice(-10)}-${usernameSuffix}`,
      displayName: 'Org follow fixture',
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!created) {
    throw new Error('Fixture user insert returned no row');
  }
  humanIds.push(created.id);
  return created.id;
}

/**
 * Insert a UserActorFollow unless the pair already exists. Returns 'added'
 * when this call inserted (and registered) the row, 'existing' when a
 * pre-existing row already proves the relation — that row is not owned and
 * is left untouched by cleanup.
 */
async function userFollowsActor(
  userId: string,
  actorId: string
): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: userActorFollows.id })
    .from(userActorFollows)
    .where(
      and(
        eq(userActorFollows.userId, userId),
        eq(userActorFollows.actorId, actorId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const id = `uaf-${runId}-${userActorFollowIds.length}`;
  await db.insert(userActorFollows).values({ id, userId, actorId });
  userActorFollowIds.push(id);
  return 'added';
}

/** Same ownership contract as userFollowsActor, for ActorFollow pairs. */
async function actorFollowsActor(
  followerId: string,
  followingId: string
): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: actorFollows.id })
    .from(actorFollows)
    .where(
      and(
        eq(actorFollows.followerId, followerId),
        eq(actorFollows.followingId, followingId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const id = `af-${runId}-${actorFollowIds.length}`;
  await db.insert(actorFollows).values({ id, followerId, followingId });
  actorFollowIds.push(id);
  return 'added';
}

interface ListPayload {
  count?: number;
  followers?: Array<{ id: string }>;
  following?: Array<{ id: string }>;
}

async function readList(
  handler: typeof getFollowers,
  identifier: string,
  kind: 'followers' | 'following'
): Promise<{ status: number; payload: ListPayload }> {
  const response = await handler(
    new NextRequest(
      `https://feed.example/api/users/${identifier}/${kind}?page=1&limit=100`
    ),
    { params: Promise.resolve({ userId: identifier }) }
  );
  const body = (await response.json()) as {
    data?: ListPayload;
  } & ListPayload;
  return { status: response.status, payload: body.data ?? body };
}

interface ListSnapshot {
  count: number;
  ids: string[];
}

async function snapshotList(
  handler: typeof getFollowers,
  identifier: string,
  kind: 'followers' | 'following'
): Promise<ListSnapshot> {
  const { status, payload } = await readList(handler, identifier, kind);
  expect(status).toBe(200);
  const entries = kind === 'followers' ? payload.followers : payload.following;
  return { count: payload.count ?? 0, ids: (entries ?? []).map((e) => e.id) };
}

async function readStats(
  identifier: string
): Promise<{ status: number; followers?: number; following?: number }> {
  const response = await getStats(
    new NextRequest(`https://feed.example/api/actors/${identifier}/stats`),
    { params: Promise.resolve({ actorId: identifier }) }
  );
  const body = (await response.json()) as {
    data?: { stats: { followers: number; following: number } };
    stats?: { followers: number; following: number };
  };
  const stats = body.data?.stats ?? body.stats;
  return {
    status: response.status,
    followers: stats?.followers,
    following: stats?.following,
  };
}

function expectListEquals(
  payload: ListPayload,
  kind: 'followers' | 'following',
  expected: ListSnapshot
) {
  const entries = kind === 'followers' ? payload.followers : payload.following;
  const ids = (entries ?? []).map((e) => e.id);
  expect(payload.count).toBe(expected.count);
  expect(new Set(ids)).toEqual(new Set(expected.ids));
}

function plusRelations(
  base: ListSnapshot,
  addedCount: number,
  memberIds: string[]
): ListSnapshot {
  return {
    count: base.count + addedCount,
    ids: [...new Set([...base.ids, ...memberIds])],
  };
}

afterAll(async () => {
  if (userActorFollowIds.length > 0) {
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, userActorFollowIds));
  }
  if (actorFollowIds.length > 0) {
    await db
      .delete(actorFollows)
      .where(inArray(actorFollows.id, actorFollowIds));
  }
  if (followIds.length > 0) {
    await db.delete(follows).where(inArray(follows.id, followIds));
  }
  // NPC User rows are deleted only when this fixture created them; a
  // canonical bootstrap row is pre-existing data and stays.
  const ownedUserIds = [...humanIds, ...createdNpcUserIds];
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('organization follow lists by organization ID', () => {
  let aimazonHumanA: string;
  let aimazonHumanB: string;
  let airkHuman: string;
  let teslaiHuman: string;

  let baseAimazonFollowers: ListSnapshot;
  let baseAimazonFollowing: ListSnapshot;
  let baseAimazonStats: { followers: number; following: number };
  let baseAirkStatsFollowers: number;
  let baseAirkFollowers: ListSnapshot;
  let baseTeslaiFollowers: ListSnapshot;

  let aimazonFollowersAdded = 0;
  let aimazonFollowingAdded = 0;
  let teslaiFollowersAdded = 0;

  beforeAll(async () => {
    runId = await generateSnowflakeId();

    // Fixture actors must exist in the static registry (the list routes enrich
    // actor relations from it and drop unknown actors).
    for (const actorId of [
      ORG_LIST_BROKEN_ACTOR,
      ORG_ALL_BROKEN_ACTOR,
      ORG_OK_ACTOR,
      ACTOR_FOLLOWER,
    ]) {
      if (!StaticDataRegistry.getActor(actorId)) {
        throw new Error(
          `Fixture actor ${actorId} missing from static registry`
        );
      }
    }
    if (!StaticDataRegistry.getOrganization(ORG_LIST_BROKEN)) {
      throw new Error(`Fixture organization ${ORG_LIST_BROKEN} missing`);
    }
    if (!StaticDataRegistry.getOrganization(ORG_ALL_BROKEN)) {
      throw new Error(`Fixture organization ${ORG_ALL_BROKEN} missing`);
    }

    // Baselines: whatever relations already exist for these canonical
    // actors in this database are captured before the fixture adds its own.
    baseAimazonFollowers = await snapshotList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    baseAimazonFollowing = await snapshotList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );
    const aimazonStats = await readStats(ORG_LIST_BROKEN);
    expect(aimazonStats.status).toBe(200);
    baseAimazonStats = {
      followers: aimazonStats.followers ?? 0,
      following: aimazonStats.following ?? 0,
    };
    const airkStats = await readStats(ORG_ALL_BROKEN);
    expect(airkStats.status).toBe(200);
    baseAirkStatsFollowers = airkStats.followers ?? 0;
    baseAirkFollowers = await snapshotList(
      getFollowers,
      ORG_ALL_BROKEN,
      'followers'
    );
    baseTeslaiFollowers = await snapshotList(getFollowers, ORG_OK, 'followers');

    aimazonHumanA = await insertHuman('ha');
    aimazonHumanB = await insertHuman('hb');
    airkHuman = await insertHuman('hc');
    teslaiHuman = await insertHuman('hd');

    // Followers of the aimazon shadow actor: 2 humans + 2 actors.
    if (
      (await userFollowsActor(aimazonHumanA, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await userFollowsActor(aimazonHumanB, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_OK_ACTOR, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      aimazonFollowersAdded += 1;
    }
    if (
      (await actorFollowsActor(ACTOR_FOLLOWER, ORG_LIST_BROKEN_ACTOR)) ===
      'added'
    ) {
      aimazonFollowersAdded += 1;
    }

    // The aimazon shadow actor follows 2 actors.
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ACTOR_FOLLOWER)) ===
      'added'
    ) {
      aimazonFollowingAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ORG_OK_ACTOR)) === 'added'
    ) {
      aimazonFollowingAdded += 1;
      teslaiFollowersAdded += 1;
    }

    // One human follower for the other two organizations.
    await userFollowsActor(airkHuman, ORG_ALL_BROKEN_ACTOR);
    if ((await userFollowsActor(teslaiHuman, ORG_OK_ACTOR)) === 'added') {
      teslaiFollowersAdded += 1;
    }
  });

  it('ground truth: the shadow actor ID itself lists the followers', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAimazonFollowers, aimazonFollowersAdded, [
        aimazonHumanA,
        aimazonHumanB,
        ORG_OK_ACTOR,
        ACTOR_FOLLOWER,
      ])
    );
  });

  it('followers list loads by organization ID with the same members', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAimazonFollowers, aimazonFollowersAdded, [
        aimazonHumanA,
        aimazonHumanB,
        ORG_OK_ACTOR,
        ACTOR_FOLLOWER,
      ])
    );
  });

  it('following list loads by organization ID', async () => {
    const { status, payload } = await readList(
      getFollowing,
      ORG_LIST_BROKEN,
      'following'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'following',
      plusRelations(baseAimazonFollowing, aimazonFollowingAdded, [
        ACTOR_FOLLOWER,
        ORG_OK_ACTOR,
      ])
    );
  });

  it('header stats agree with the lists for the same organization', async () => {
    const stats = await readStats(ORG_LIST_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(
      baseAimazonStats.followers + aimazonFollowersAdded
    );
    expect(stats.following).toBe(
      baseAimazonStats.following + aimazonFollowingAdded
    );
  });

  it('stats and list both resolve for an organization without a name match', async () => {
    const stats = await readStats(ORG_ALL_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(baseAirkStatsFollowers + 1);

    const { status, payload } = await readList(
      getFollowers,
      ORG_ALL_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseAirkFollowers, 1, [airkHuman])
    );
  });

  it('control: an organization that already resolves keeps working', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_OK,
      'followers'
    );
    expect(status).toBe(200);
    // The baseline members plus the fixture's additions: the human fixture
    // and the aimazon shadow actor, which follows this organization.
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseTeslaiFollowers, teslaiFollowersAdded, [
        teslaiHuman,
        ORG_LIST_BROKEN_ACTOR,
      ])
    );
  });

  it('unknown identifiers still return 404', async () => {
    const { status } = await readList(
      getFollowers,
      'no-such-org-or-user-69',
      'followers'
    );
    expect(status).toBe(404);
  });
});

describe('canonical NPC user row dispatch', () => {
  let baseFollowers: ListSnapshot;
  let baseFollowing: ListSnapshot;
  let dispatchHuman: string;
  let dispatchHumanFollower: string;
  let followerAdded = 0;
  let followingAdded = 0;

  beforeAll(async () => {
    // Pre-fixture state for the shadow actor, read through the routes. The
    // first describe's fixtures are part of this baseline; expectations
    // below are relative to it.
    baseFollowers = await snapshotList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    baseFollowing = await snapshotList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );

    // Ensure the canonical NPC User row exists, in the exact shape game
    // bootstrap creates (id and username are the actor ID, isActor set).
    // When the row already exists it is canonical data: it is used as-is
    // and never deleted by this fixture.
    const actor = StaticDataRegistry.getActor(ORG_LIST_BROKEN_ACTOR);
    if (!actor) {
      throw new Error(`Fixture actor ${ORG_LIST_BROKEN_ACTOR} missing`);
    }
    const [existingNpcRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);
    if (!existingNpcRow) {
      const now = new Date();
      const [created] = await db
        .insert(users)
        .values({
          id: actor.id,
          username: actor.id,
          displayName: actor.name,
          isActor: true,
          virtualBalance: '10000',
          totalDeposited: '10000',
          totalWithdrawn: '0',
          lifetimePnL: '0',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: users.id });
      if (!created) {
        throw new Error('Fixture NPC user insert returned no row');
      }
      createdNpcUserIds.push(created.id);
    }

    dispatchHuman = await insertHuman('np');
    if (
      (await userFollowsActor(dispatchHuman, ORG_LIST_BROKEN_ACTOR)) === 'added'
    ) {
      followerAdded += 1;
    }
    if (
      (await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ORG_ALL_BROKEN_ACTOR)) ===
      'added'
    ) {
      followingAdded += 1;
    }

    // Ordinary human control: one fixture human follows another through the
    // plain Follow table.
    const humanFollower = await insertHuman('nh');
    const followId = `f-${runId}-dispatch`;
    await db.insert(follows).values({
      id: followId,
      followerId: humanFollower,
      followingId: dispatchHuman,
    });
    followIds.push(followId);
    dispatchHumanFollower = humanFollower;
  });

  it('followers by shadow actor ID use the actor branch with the NPC row present', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseFollowers, followerAdded, [dispatchHuman])
    );
  });

  it('following by shadow actor ID uses the actor branch with the NPC row present', async () => {
    const { status, payload } = await readList(
      getFollowing,
      ORG_LIST_BROKEN_ACTOR,
      'following'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'following',
      plusRelations(baseFollowing, followingAdded, [ORG_ALL_BROKEN_ACTOR])
    );
  });

  it('followers by actor username resolve without a matching user row', async () => {
    const actor = StaticDataRegistry.getActor(ORG_LIST_BROKEN_ACTOR);
    if (!actor?.username) {
      throw new Error('Fixture actor has no username');
    }
    // The canonical NPC row's username is the actor ID, so this identifier
    // matches no users-table row and must fall through to the registry.
    const { status, payload } = await readList(
      getFollowers,
      actor.username,
      'followers'
    );
    expect(status).toBe(200);
    expectListEquals(
      payload,
      'followers',
      plusRelations(baseFollowers, followerAdded, [dispatchHuman])
    );
  });

  it('ordinary human accounts keep the human follow branches', async () => {
    const followersResult = await readList(
      getFollowers,
      dispatchHuman,
      'followers'
    );
    expect(followersResult.status).toBe(200);
    expect(followersResult.payload.count).toBe(1);
    expect(
      (followersResult.payload.followers ?? []).map((f) => f.id)
    ).toContain(dispatchHumanFollower);

    const followingResult = await readList(
      getFollowing,
      dispatchHumanFollower,
      'following'
    );
    expect(followingResult.status).toBe(200);
    expect(followingResult.payload.count).toBe(1);
    expect(
      (followingResult.payload.following ?? []).map((f) => f.id)
    ).toContain(dispatchHuman);
  });
});

/**
 * Organization profile stats against a real database: the header "Posts"
 * count on an organization profile (/orgs/[id]) must count the posts that
 * same page lists.
 *
 * One user action: open an organization profile. ProfilePageClient renders
 * the posts tab from `GET /api/posts?actorId={org.id}` — posts authored
 * under the organization id, which is a real production path
 * (generateOrgPost writes `authorId: org.id`) — and the header counts from
 * `GET /api/actors/[actorId]/stats` with that same org id.
 *
 * The stats route resolves the org id to the organization's shadow actor
 * (orgs share a username with their official-voice actor, e.g. org
 * `teslai` vs actor `org-teslai`) and counts posts under the actor id
 * instead. The two reads are keyed differently, so the header count can
 * never describe the list below it: org-authored posts are not counted,
 * and shadow-actor posts the page never lists are. Follows are keyed by
 * the resolved actor id on both the write path (the follow route resolves
 * the same way) and this route, so the follower counts already agree and
 * are asserted unchanged.
 *
 * The identifiers are canonical registry entries, so the database may
 * already hold posts and follows for them. Assertions are therefore
 * baseline-relative: the pre-existing stats are captured through the
 * route before any fixture row is inserted, and each test expects exactly
 * the baseline plus the relations the fixture actually added. No
 * pre-existing record is deleted or reset to make the counts fit.
 *
 * Fixture rows are registered only after their INSERT succeeds
 * (RETURNING for users and posts; a follow pair that already exists is
 * reported as pre-existing instead of being claimed). Cleanup deletes
 * only owned rows and is safe after a partial setup: whatever was
 * registered is removed, nothing else. A collision control at the end
 * proves a failed insert registers nothing.
 *
 * The only stub is the `server-only` marker package; the static registry
 * and every database dependency run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorFollows,
  and,
  db,
  eq,
  inArray,
  posts,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type StatsResponse = {
  stats?: {
    followers: number;
    following: number;
    posts: number;
    actorFollowers: number;
    userFollowers: number;
  };
};

type StatsSnapshot = NonNullable<StatsResponse['stats']>;

let GET_STATS: typeof import('../../../apps/web/src/app/api/actors/[actorId]/stats/route').GET;

let orgId: string;
let shadowActorId: string;
let controlActorId: string;
let followerUserId: string;
let npcFollowerId: string;

// Rows this fixture provably owns, registered only after a successful
// insert; cleanup deletes exactly these.
const ownedPostIds: string[] = [];
const ownedUserActorFollowIds: string[] = [];
const ownedActorFollowIds: string[] = [];
const ownedUserIds: string[] = [];

let baseOrgStats: StatsSnapshot;
let baseShadowStats: StatsSnapshot;
let baseControlStats: StatsSnapshot;
let orgActorFollowersAdded = 0;

async function fetchStats(identifier: string) {
  const request = new NextRequest(
    new Request(
      `http://localhost/api/actors/${encodeURIComponent(identifier)}/stats`
    )
  );
  const response = await GET_STATS(request, {
    params: Promise.resolve({ actorId: identifier }),
  });
  const body = (await response
    .json()
    .catch(() => null)) as StatsResponse | null;
  return { status: response.status, body };
}

async function snapshotStats(identifier: string): Promise<StatsSnapshot> {
  const { status, body } = await fetchStats(identifier);
  expect(status).toBe(200);
  if (!body?.stats) {
    throw new Error(`Stats snapshot for ${identifier} returned no stats`);
  }
  return body.stats;
}

async function insertPost(values: {
  content: string;
  authorId: string;
  timestamp: Date;
  createdAt: Date;
  deletedAt?: Date;
}): Promise<string> {
  const [created] = await db
    .insert(posts)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({ id: posts.id });
  if (!created) {
    throw new Error('Fixture post insert returned no row');
  }
  ownedPostIds.push(created.id);
  return created.id;
}

async function insertUserActorFollow(values: {
  userId: string;
  actorId: string;
  createdAt: Date;
}): Promise<void> {
  const [created] = await db
    .insert(userActorFollows)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({ id: userActorFollows.id });
  if (!created) {
    throw new Error('Fixture user-actor follow insert returned no row');
  }
  ownedUserActorFollowIds.push(created.id);
}

/**
 * Insert an ActorFollow unless the pair already exists. Returns 'added'
 * when this call inserted (and registered) the row, 'existing' when a
 * pre-existing row already proves the relation — that row is not owned
 * and is left untouched by cleanup.
 */
async function insertActorFollow(values: {
  followerId: string;
  followingId: string;
  createdAt: Date;
}): Promise<'added' | 'existing'> {
  const [existing] = await db
    .select({ id: actorFollows.id })
    .from(actorFollows)
    .where(
      and(
        eq(actorFollows.followerId, values.followerId),
        eq(actorFollows.followingId, values.followingId)
      )
    )
    .limit(1);
  if (existing) {
    return 'existing';
  }
  const [created] = await db
    .insert(actorFollows)
    .values({ id: await generateSnowflakeId(), ...values })
    .returning({ id: actorFollows.id });
  if (!created) {
    throw new Error('Fixture actor follow insert returned no row');
  }
  ownedActorFollowIds.push(created.id);
  return 'added';
}

/**
 * Delete only the rows registered as owned. Idempotent: the registries
 * are emptied, so the afterAll call after the collision control already
 * ran it is a no-op.
 */
async function cleanupOwnedFixtures(): Promise<void> {
  if (ownedUserActorFollowIds.length > 0) {
    const ids = ownedUserActorFollowIds.splice(
      0,
      ownedUserActorFollowIds.length
    );
    await db.delete(userActorFollows).where(inArray(userActorFollows.id, ids));
  }
  if (ownedActorFollowIds.length > 0) {
    const ids = ownedActorFollowIds.splice(0, ownedActorFollowIds.length);
    await db.delete(actorFollows).where(inArray(actorFollows.id, ids));
  }
  if (ownedPostIds.length > 0) {
    const ids = ownedPostIds.splice(0, ownedPostIds.length);
    await db.delete(posts).where(inArray(posts.id, ids));
  }
  if (ownedUserIds.length > 0) {
    const ids = ownedUserIds.splice(0, ownedUserIds.length);
    await db.delete(users).where(inArray(users.id, ids));
  }
}

beforeAll(async () => {
  ({ GET: GET_STATS } = await import(
    '../../../apps/web/src/app/api/actors/[actorId]/stats/route'
  ));

  const org =
    StaticDataRegistry.getOrganization('teslai') ??
    StaticDataRegistry.getAllOrganizations()[0];
  if (!org) throw new Error('static registry returned no organization');
  orgId = org.id;

  // The org's official-voice actor: the route resolves the org id to this
  // actor through the shared username.
  const shadow = StaticDataRegistry.getActor(orgId);
  if (!shadow) throw new Error('org has no shadow actor in the registry');
  shadowActorId = shadow.id;

  const controlActor = StaticDataRegistry.getAllActors().find(
    (a) => a.id !== shadowActorId
  );
  if (!controlActor) throw new Error('static registry returned no actor');
  controlActorId = controlActor.id;
  npcFollowerId =
    StaticDataRegistry.getAllActors().find(
      (a) => a.id !== shadowActorId && a.id !== controlActorId
    )?.id ?? 'npc-follower';

  // Baselines: whatever the canonical identifiers already have in this
  // database is captured before the fixture adds anything.
  baseOrgStats = await snapshotStats(orgId);
  baseShadowStats = await snapshotStats(shadowActorId);
  baseControlStats = await snapshotStats(controlActorId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  const followerCandidateId = await generateSnowflakeId();
  const [createdFollower] = await db
    .insert(users)
    .values({
      id: followerCandidateId,
      username: `f55-${followerCandidateId}`,
      displayName: 'F55 Fixture Follower',
      updatedAt: now,
    })
    .returning({ id: users.id });
  if (!createdFollower) {
    throw new Error('Fixture follower insert returned no row');
  }
  ownedUserIds.push(createdFollower.id);
  followerUserId = createdFollower.id;

  // Posts authored under the organization id (the generateOrgPost path):
  // two visible, one soft-deleted, one future-dated. The org page's posts
  // tab can only ever show the two visible ones.
  await insertPost({
    content: 'org visible post one',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
  });
  await insertPost({
    content: 'org visible post two',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
  });
  await insertPost({
    content: 'org soft-deleted post',
    authorId: orgId,
    timestamp: past,
    createdAt: past,
    deletedAt: past,
  });
  await insertPost({
    content: 'org future post that must not be hinted at',
    authorId: orgId,
    timestamp: future,
    createdAt: past,
  });

  // One visible post authored under the shadow actor id. It belongs to
  // the actor profile (/actors/{shadowId}), not to the org page's list.
  await insertPost({
    content: 'shadow actor visible post',
    authorId: shadowActorId,
    timestamp: past,
    createdAt: past,
  });

  // Follows of the org's account land on the resolved (shadow) actor id —
  // the follow route resolves the org id the same way — one user follow
  // and one NPC follow.
  await insertUserActorFollow({
    userId: followerUserId,
    actorId: shadowActorId,
    createdAt: past,
  });
  if (
    (await insertActorFollow({
      followerId: npcFollowerId,
      followingId: shadowActorId,
      createdAt: past,
    })) === 'added'
  ) {
    orgActorFollowersAdded += 1;
  }

  // Control: an unrelated actor authored one visible post and has the
  // same user following it. Actor stats already work and must not change.
  await insertPost({
    content: 'control actor visible post',
    authorId: controlActorId,
    timestamp: past,
    createdAt: past,
  });
  await insertUserActorFollow({
    userId: followerUserId,
    actorId: controlActorId,
    createdAt: past,
  });
});

afterAll(async () => {
  await cleanupOwnedFixtures();
});

describe('organization profile stats', () => {
  it('counts the posts the organization page lists, under the org id', async () => {
    const { status, body } = await fetchStats(orgId);
    expect(status).toBe(200);
    // The org page lists the two visible org-authored posts on top of
    // whatever the org already had; the header must not report the
    // shadow actor's count instead.
    expect(body?.stats?.posts).toBe(baseOrgStats.posts + 2);
    // Follows already agree (both paths key by the resolved actor id).
    expect(body?.stats?.userFollowers).toBe(baseOrgStats.userFollowers + 1);
    expect(body?.stats?.actorFollowers).toBe(
      baseOrgStats.actorFollowers + orgActorFollowersAdded
    );
    expect(body?.stats?.followers).toBe(
      baseOrgStats.followers + 1 + orgActorFollowersAdded
    );
    expect(body?.stats?.following).toBe(baseOrgStats.following);
  });

  it('still returns the shadow actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(shadowActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(baseShadowStats.posts + 1);
    expect(body?.stats?.followers).toBe(
      baseShadowStats.followers + 1 + orgActorFollowersAdded
    );
  });

  it('still returns unrelated actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(controlActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(baseControlStats.posts + 1);
    expect(body?.stats?.userFollowers).toBe(baseControlStats.userFollowers + 1);
    expect(body?.stats?.followers).toBe(baseControlStats.followers + 1);
  });

  it('still errors for an unknown identifier (control)', async () => {
    const { status, body } = await fetchStats('f55-no-such-entity');
    expect(status).toBe(400);
    expect(body?.stats).toBeUndefined();
  });

  it('fixture ownership: colliding inserts register nothing and cleanup leaves pre-existing rows untouched', async () => {
    // Pre-existing rows the fixture does not own (stand-ins for canonical
    // or another suite's data): an author, a post, and a user-actor
    // follow.
    const victimAuthorId = await generateSnowflakeId();
    await db.insert(users).values({
      id: victimAuthorId,
      username: `f55-victim-${victimAuthorId}`,
      displayName: 'F55 Pre-existing Author',
      updatedAt: new Date(),
    });
    const victimPostId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: victimPostId,
      content: 'f55 pre-existing post',
      authorId: victimAuthorId,
      timestamp: new Date(),
      createdAt: new Date(),
    });
    const victimFollowId = await generateSnowflakeId();
    await db.insert(userActorFollows).values({
      id: victimFollowId,
      userId: victimAuthorId,
      actorId: controlActorId,
      createdAt: new Date(),
    });

    // Candidates reusing those IDs: both inserts fail, so neither ID may
    // enter the owned registries.
    let postCollisionThrew = false;
    try {
      const [collided] = await db
        .insert(posts)
        .values({
          id: victimPostId,
          content: 'f55 colliding post candidate',
          authorId: victimAuthorId,
          timestamp: new Date(),
          createdAt: new Date(),
        })
        .returning({ id: posts.id });
      if (collided) {
        ownedPostIds.push(collided.id);
      }
    } catch {
      postCollisionThrew = true;
    }
    expect(postCollisionThrew).toBe(true);
    expect(ownedPostIds).not.toContain(victimPostId);

    let followCollisionThrew = false;
    try {
      const [collided] = await db
        .insert(userActorFollows)
        .values({
          id: victimFollowId,
          userId: victimAuthorId,
          actorId: shadowActorId,
          createdAt: new Date(),
        })
        .returning({ id: userActorFollows.id });
      if (collided) {
        ownedUserActorFollowIds.push(collided.id);
      }
    } catch {
      followCollisionThrew = true;
    }
    expect(followCollisionThrew).toBe(true);
    expect(ownedUserActorFollowIds).not.toContain(victimFollowId);

    await cleanupOwnedFixtures();

    // The pre-existing rows survive; the fixture's own rows are gone.
    const [survivingPost] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, victimPostId));
    expect(survivingPost?.id).toBe(victimPostId);
    const [survivingFollow] = await db
      .select({ id: userActorFollows.id })
      .from(userActorFollows)
      .where(eq(userActorFollows.id, victimFollowId));
    expect(survivingFollow?.id).toBe(victimFollowId);
    const [survivingAuthor] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, victimAuthorId));
    expect(survivingAuthor?.id).toBe(victimAuthorId);
    const [ownedFollower] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, followerUserId));
    expect(ownedFollower).toBeUndefined();

    // Remove the stand-ins themselves; they were never part of the fixture.
    await db
      .delete(userActorFollows)
      .where(eq(userActorFollows.id, victimFollowId));
    await db.delete(posts).where(eq(posts.id, victimPostId));
    await db.delete(users).where(eq(users.id, victimAuthorId));
  });
});

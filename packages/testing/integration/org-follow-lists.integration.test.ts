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
 * Nothing is mocked: the real route handlers run against the real database.
 * Fixture rows are owned and removed after the run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { actorFollows, db, inArray, userActorFollows, users } from '@feed/db';
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

async function insertHuman(usernameSuffix: string): Promise<string> {
  const id = await generateSnowflakeId();
  humanIds.push(id);
  await db.insert(users).values({
    id,
    username: `of69-${runId.slice(-10)}-${usernameSuffix}`,
    displayName: 'Org follow fixture',
    updatedAt: new Date(),
  });
  return id;
}

async function userFollowsActor(userId: string, actorId: string) {
  const id = `uaf-${runId}-${userActorFollowIds.length}`;
  userActorFollowIds.push(id);
  await db.insert(userActorFollows).values({ id, userId, actorId });
}

async function actorFollowsActor(followerId: string, followingId: string) {
  const id = `af-${runId}-${actorFollowIds.length}`;
  actorFollowIds.push(id);
  await db.insert(actorFollows).values({ id, followerId, followingId });
}

let aimazonHumanA: string;
let aimazonHumanB: string;
let airkHuman: string;
let teslaiHuman: string;

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
      throw new Error(`Fixture actor ${actorId} missing from static registry`);
    }
  }
  if (!StaticDataRegistry.getOrganization(ORG_LIST_BROKEN)) {
    throw new Error(`Fixture organization ${ORG_LIST_BROKEN} missing`);
  }
  if (!StaticDataRegistry.getOrganization(ORG_ALL_BROKEN)) {
    throw new Error(`Fixture organization ${ORG_ALL_BROKEN} missing`);
  }

  aimazonHumanA = await insertHuman('ha');
  aimazonHumanB = await insertHuman('hb');
  airkHuman = await insertHuman('hc');
  teslaiHuman = await insertHuman('hd');

  // Followers of the aimazon shadow actor: 2 humans + 2 actors.
  await userFollowsActor(aimazonHumanA, ORG_LIST_BROKEN_ACTOR);
  await userFollowsActor(aimazonHumanB, ORG_LIST_BROKEN_ACTOR);
  await actorFollowsActor(ORG_OK_ACTOR, ORG_LIST_BROKEN_ACTOR);
  await actorFollowsActor(ACTOR_FOLLOWER, ORG_LIST_BROKEN_ACTOR);

  // The aimazon shadow actor follows 2 actors.
  await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ACTOR_FOLLOWER);
  await actorFollowsActor(ORG_LIST_BROKEN_ACTOR, ORG_OK_ACTOR);

  // One human follower for the other two organizations.
  await userFollowsActor(airkHuman, ORG_ALL_BROKEN_ACTOR);
  await userFollowsActor(teslaiHuman, ORG_OK_ACTOR);
});

afterAll(async () => {
  await db
    .delete(userActorFollows)
    .where(inArray(userActorFollows.id, userActorFollowIds));
  await db.delete(actorFollows).where(inArray(actorFollows.id, actorFollowIds));
  await db.delete(users).where(inArray(users.id, humanIds));
});

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

describe('organization follow lists by organization ID', () => {
  it('ground truth: the shadow actor ID itself lists the followers', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN_ACTOR,
      'followers'
    );
    expect(status).toBe(200);
    expect(payload.count).toBe(4);
    const ids = (payload.followers ?? []).map((f) => f.id);
    expect(ids).toContain(aimazonHumanA);
    expect(ids).toContain(aimazonHumanB);
    expect(ids).toContain(ORG_OK_ACTOR);
    expect(ids).toContain(ACTOR_FOLLOWER);
  });

  it('followers list loads by organization ID with the same members', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_LIST_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expect(payload.count).toBe(4);
    const ids = (payload.followers ?? []).map((f) => f.id);
    expect(ids).toContain(aimazonHumanA);
    expect(ids).toContain(aimazonHumanB);
    expect(ids).toContain(ORG_OK_ACTOR);
    expect(ids).toContain(ACTOR_FOLLOWER);
  });

  it('following list loads by organization ID', async () => {
    const { status, payload } = await readList(
      getFollowing,
      ORG_LIST_BROKEN,
      'following'
    );
    expect(status).toBe(200);
    expect(payload.count).toBe(2);
    const ids = (payload.following ?? []).map((f) => f.id);
    expect(ids).toContain(ACTOR_FOLLOWER);
    expect(ids).toContain(ORG_OK_ACTOR);
  });

  it('header stats agree with the lists for the same organization', async () => {
    const stats = await readStats(ORG_LIST_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(4);
    expect(stats.following).toBe(2);
  });

  it('stats and list both resolve for an organization without a name match', async () => {
    const stats = await readStats(ORG_ALL_BROKEN);
    expect(stats.status).toBe(200);
    expect(stats.followers).toBe(1);

    const { status, payload } = await readList(
      getFollowers,
      ORG_ALL_BROKEN,
      'followers'
    );
    expect(status).toBe(200);
    expect(payload.count).toBe(1);
    const ids = (payload.followers ?? []).map((f) => f.id);
    expect(ids).toContain(airkHuman);
  });

  it('control: an organization that already resolves keeps working', async () => {
    const { status, payload } = await readList(
      getFollowers,
      ORG_OK,
      'followers'
    );
    expect(status).toBe(200);
    // The human fixture plus the aimazon shadow actor, which follows it.
    expect(payload.count).toBe(2);
    const ids = (payload.followers ?? []).map((f) => f.id);
    expect(ids).toContain(teslaiHuman);
    expect(ids).toContain(ORG_LIST_BROKEN_ACTOR);
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

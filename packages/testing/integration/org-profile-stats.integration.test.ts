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
 * The only stub is the `server-only` marker package; the static registry
 * and every database dependency run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorFollows,
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

let GET_STATS: typeof import('../../../apps/web/src/app/api/actors/[actorId]/stats/route').GET;

let orgId: string;
let shadowActorId: string;
let controlActorId: string;
let followerUserId: string;
let npcFollowerId: string;

const allPostIds: string[] = [];
const allUserActorFollowIds: string[] = [];
const allActorFollowIds: string[] = [];

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

  followerUserId = await generateSnowflakeId();

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);
  const future = new Date(now.getTime() + 2 * 60 * 60_000);

  await db.insert(users).values({
    id: followerUserId,
    username: `f55-${followerUserId}`,
    displayName: 'F55 Fixture Follower',
    updatedAt: now,
  });

  // Posts authored under the organization id (the generateOrgPost path):
  // two visible, one soft-deleted, one future-dated. The org page's posts
  // tab can only ever show the two visible ones.
  const orgPostIds = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  allPostIds.push(...orgPostIds);
  await db.insert(posts).values([
    {
      id: orgPostIds[0]!,
      content: 'org visible post one',
      authorId: orgId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: orgPostIds[1]!,
      content: 'org visible post two',
      authorId: orgId,
      timestamp: past,
      createdAt: past,
    },
    {
      id: orgPostIds[2]!,
      content: 'org soft-deleted post',
      authorId: orgId,
      timestamp: past,
      createdAt: past,
      deletedAt: past,
    },
    {
      id: orgPostIds[3]!,
      content: 'org future post that must not be hinted at',
      authorId: orgId,
      timestamp: future,
      createdAt: past,
    },
  ]);

  // One visible post authored under the shadow actor id. It belongs to
  // the actor profile (/actors/{shadowId}), not to the org page's list.
  const shadowPostId = await generateSnowflakeId();
  allPostIds.push(shadowPostId);
  await db.insert(posts).values({
    id: shadowPostId,
    content: 'shadow actor visible post',
    authorId: shadowActorId,
    timestamp: past,
    createdAt: past,
  });

  // Follows of the org's account land on the resolved (shadow) actor id —
  // the follow route resolves the org id the same way — one user follow
  // and one NPC follow.
  const userFollowId = await generateSnowflakeId();
  allUserActorFollowIds.push(userFollowId);
  await db.insert(userActorFollows).values({
    id: userFollowId,
    userId: followerUserId,
    actorId: shadowActorId,
    createdAt: past,
  });
  const actorFollowId = await generateSnowflakeId();
  allActorFollowIds.push(actorFollowId);
  await db.insert(actorFollows).values({
    id: actorFollowId,
    followerId: npcFollowerId,
    followingId: shadowActorId,
    createdAt: past,
  });

  // Control: an unrelated actor authored one visible post and has the
  // same user following it. Actor stats already work and must not change.
  const controlPostId = await generateSnowflakeId();
  allPostIds.push(controlPostId);
  await db.insert(posts).values({
    id: controlPostId,
    content: 'control actor visible post',
    authorId: controlActorId,
    timestamp: past,
    createdAt: past,
  });
  const controlFollowId = await generateSnowflakeId();
  allUserActorFollowIds.push(controlFollowId);
  await db.insert(userActorFollows).values({
    id: controlFollowId,
    userId: followerUserId,
    actorId: controlActorId,
    createdAt: past,
  });
});

afterAll(async () => {
  await db
    .delete(userActorFollows)
    .where(inArray(userActorFollows.id, allUserActorFollowIds));
  await db
    .delete(actorFollows)
    .where(inArray(actorFollows.id, allActorFollowIds));
  await db.delete(posts).where(inArray(posts.id, allPostIds));
  await db.delete(users).where(eq(users.id, followerUserId));
});

describe('organization profile stats', () => {
  it('counts the posts the organization page lists, under the org id', async () => {
    const { status, body } = await fetchStats(orgId);
    expect(status).toBe(200);
    // The org page lists the two visible org-authored posts; the header
    // must not report the shadow actor's count (1) instead.
    expect(body?.stats?.posts).toBe(2);
    // Follows already agree (both paths key by the resolved actor id).
    expect(body?.stats?.userFollowers).toBe(1);
    expect(body?.stats?.actorFollowers).toBe(1);
    expect(body?.stats?.followers).toBe(2);
    expect(body?.stats?.following).toBe(0);
  });

  it('still returns the shadow actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(shadowActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(1);
    expect(body?.stats?.followers).toBe(2);
  });

  it('still returns unrelated actor stats unchanged (control)', async () => {
    const { status, body } = await fetchStats(controlActorId);
    expect(status).toBe(200);
    expect(body?.stats?.posts).toBe(1);
    expect(body?.stats?.userFollowers).toBe(1);
    expect(body?.stats?.followers).toBe(1);
  });

  it('still errors for an unknown identifier (control)', async () => {
    const { status, body } = await fetchStats('f55-no-such-entity');
    expect(status).toBe(400);
    expect(body?.stats).toBeUndefined();
  });
});

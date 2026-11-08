/**
 * GET /api/registry/all (the entity directory behind the admin registry
 * panel and the explore entity search) against a real database: the
 * Followers number shown for an actor (NPC) must be the actor's follower
 * count — the same number the actor's own profile header shows.
 *
 * One user action: open the registry/directory, read an actor's Followers
 * stat, then open that actor's profile and read the Followers number in
 * the header (ProfilePageClient renders `GET /api/actors/[actorId]/stats`).
 * The profile stats route composes the count from both follow tables —
 * NPC-to-NPC follows (ActorFollow) plus user follows (UserActorFollow) —
 * with the comment "Get follower counts (both from ActorFollow and
 * UserActorFollow)". The directory's actors branch counts only ActorFollow
 * rows, so every user who follows the actor is missing from the directory
 * number: an actor followed by 1 NPC and 3 users shows Followers 1 in the
 * directory and 4 on its profile.
 *
 * This route deliberately returns every registered entity (it also serves
 * the admin registry panel), so the fixture's test and banned user
 * followers are counted — matching the profile header at base. The defect
 * is the missing follow table, not a membership filter.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorFollows,
  actorState,
  db,
  eq,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const TARGET_ACTOR = 'ailon-musk';
const CONTROL_ACTOR = 'aellai';

type DirectoryResponse = {
  actors: Array<{
    id: string;
    stats: { followers: number; following: number };
  }>;
  totals: { actors: number };
};

type ActorStatsResponse = {
  stats: { followers: number; following: number };
};

let GET_ALL: typeof import('../../../apps/web/src/app/api/registry/all/route').GET;
let GET_STATS: typeof import('../../../apps/web/src/app/api/actors/[actorId]/stats/route').GET;

const fixtureUserIds: string[] = [];
const fixtureFollowIds: string[] = [];

async function fetchDirectory() {
  const request = new NextRequest(
    new Request('http://localhost/api/registry/all?type=actors')
  );
  const response = await GET_ALL(request);
  const body = (await response.json().catch(() => null)) as
    | DirectoryResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

async function fetchProfileStats(actorId: string) {
  const request = new NextRequest(
    new Request(`http://localhost/api/actors/${actorId}/stats`)
  );
  const response = await GET_STATS(request, {
    params: Promise.resolve({ actorId }),
  });
  const body = (await response.json().catch(() => null)) as
    | ActorStatsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET: GET_ALL } = await import(
    '../../../apps/web/src/app/api/registry/all/route'
  ));
  ({ GET: GET_STATS } = await import(
    '../../../apps/web/src/app/api/actors/[actorId]/stats/route'
  ));

  const now = new Date();

  // Pin the target actor to the top of the directory's reputation-sorted
  // first-100 slice so the fixture does not depend on static pack order.
  await db.insert(actorState).values({
    id: TARGET_ACTOR,
    reputationPoints: 999999,
    updatedAt: now,
  });

  // Three users follow the target actor: one regular, one test account,
  // one banned account. This route returns every registered entity (it
  // serves the admin registry panel), so all three are real follower rows
  // the profile header counts.
  const userSpecs = [
    { suffix: 'regular', isTest: false, isBanned: false },
    { suffix: 'test', isTest: true, isBanned: false },
    { suffix: 'banned', isTest: false, isBanned: true },
  ];
  for (const spec of userSpecs) {
    const userId = await generateSnowflakeId();
    fixtureUserIds.push(userId);
    await db.insert(users).values({
      id: userId,
      username: `f61-${spec.suffix}-${userId}`,
      displayName: `F61 ${spec.suffix} follower`,
      isTest: spec.isTest,
      isBanned: spec.isBanned,
      updatedAt: now,
    });
    const followId = await generateSnowflakeId();
    fixtureFollowIds.push(followId);
    await db.insert(userActorFollows).values({
      id: followId,
      userId,
      actorId: TARGET_ACTOR,
      createdAt: now,
    });
  }

  // NPC follows in both directions: the control actor follows the target,
  // and the target follows the control actor.
  const npcFollowIds = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  fixtureFollowIds.push(...npcFollowIds);
  await db.insert(actorFollows).values([
    {
      id: npcFollowIds[0]!,
      followerId: CONTROL_ACTOR,
      followingId: TARGET_ACTOR,
      createdAt: now,
    },
    {
      id: npcFollowIds[1]!,
      followerId: TARGET_ACTOR,
      followingId: CONTROL_ACTOR,
      createdAt: now,
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(userActorFollows)
    .where(eq(userActorFollows.actorId, TARGET_ACTOR));
  await db
    .delete(actorFollows)
    .where(inArray(actorFollows.id, fixtureFollowIds));
  await db.delete(actorState).where(eq(actorState.id, TARGET_ACTOR));
  await db.delete(users).where(inArray(users.id, fixtureUserIds));
});

describe('GET /api/registry/all actor follower counts', () => {
  it('profile oracle: the actor profile header counts both follow tables', async () => {
    const { status, body } = await fetchProfileStats(TARGET_ACTOR);
    expect(status).toBe(200);
    // 1 NPC follower (ActorFollow) + 3 user followers (UserActorFollow).
    expect((body as ActorStatsResponse).stats.followers).toBe(4);
    expect((body as ActorStatsResponse).stats.following).toBe(1);
  });

  it('directory shows the same follower count as the actor profile', async () => {
    const { status, body } = await fetchDirectory();
    expect(status).toBe(200);
    const list = body as DirectoryResponse;
    const entry = list.actors.find((a) => a.id === TARGET_ACTOR);
    expect(entry).toBeDefined();
    // Base counts only the ActorFollow row and shows 1.
    expect(entry!.stats.followers).toBe(4);
    expect(entry!.stats.following).toBe(1);
  });

  it('guard: an actor with only NPC follows is unchanged', async () => {
    const { status, body } = await fetchDirectory();
    expect(status).toBe(200);
    const list = body as DirectoryResponse;
    const control = list.actors.find((a) => a.id === CONTROL_ACTOR);
    expect(control).toBeDefined();
    // Followed by the target actor (1 NPC), follows the target actor (1).
    // No user follows, so the fix must not move this number.
    expect(control!.stats.followers).toBe(1);
    expect(control!.stats.following).toBe(1);
  });
});

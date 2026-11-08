/**
 * Actor profile stats against a real database: the follower counts on an
 * actor (NPC) profile must count the same membership the followers list
 * shows.
 *
 * One user action: open an actor profile, read the Followers number in the
 * header (ProfilePageClient renders `GET /api/actors/[actorId]/stats`), then
 * open the followers list (FollowListModal → `GET /api/users/[actorId]/
 * followers`, NPC branch). The list's membership rule is the one every
 * discovery surface uses — hidden account tiers never appear (test
 * accounts: `isTest` flag or an id starting with 'test-'; banned accounts) —
 * and the follow-list fix (#1697) applies exactly that membership to the
 * UserActorFollow branch of the list. The stats route counted every
 * UserActorFollow row, so on the same actor profile screen the header
 * number includes followers the list will never show.
 *
 * NPC-to-NPC follows (ActorFollow) have no user account tiers, so the
 * actorFollowers component is asserted unchanged as a control.
 *
 * The only stub is the `server-only` marker package; every database
 * dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorFollows,
  count,
  db,
  eq,
  inArray,
  userActorFollows,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let GET_STATS: typeof import('../../../apps/web/src/app/api/actors/[actorId]/stats/route').GET;

let actorId: string;
let npcFollowerId: string;

const allUserIds: string[] = [];
const allUserActorFollowIds: string[] = [];
const allActorFollowIds: string[] = [];

async function insertUser(
  id: string,
  label: string,
  flags: { isTest?: boolean; isBanned?: boolean } = {}
) {
  allUserIds.push(id);
  await db.insert(users).values({
    id,
    username: `f7${label}-${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`,
    displayName: `F7 ${label}`,
    isTest: flags.isTest ?? false,
    isBanned: flags.isBanned ?? false,
    updatedAt: new Date(),
  });
}

async function insertUserActorFollow(userId: string) {
  const id = await generateSnowflakeId();
  allUserActorFollowIds.push(id);
  await db.insert(userActorFollows).values({
    id,
    userId,
    actorId,
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  ({ GET: GET_STATS } = await import(
    '../../../apps/web/src/app/api/actors/[actorId]/stats/route'
  ));

  const actors = StaticDataRegistry.getAllActors();
  const actor = actors[0];
  const npcFollower = actors[1];
  if (!actor || !npcFollower) {
    throw new Error('static actor registry needs at least two actors');
  }
  actorId = actor.id;
  npcFollowerId = npcFollower.id;

  const normalA = await generateSnowflakeId();
  const normalB = await generateSnowflakeId();
  const testFlagged = await generateSnowflakeId();
  const banned = await generateSnowflakeId();
  const testPrefixed = `test-f7-${await generateSnowflakeId()}`;

  await insertUser(normalA, 'normala');
  await insertUser(normalB, 'normalb');
  await insertUser(testFlagged, 'testflag', { isTest: true });
  await insertUser(testPrefixed, 'testpref');
  await insertUser(banned, 'banned', { isBanned: true });

  // Five users follow the actor: two real accounts plus one of each
  // hidden tier.
  for (const userId of [normalA, normalB, testFlagged, testPrefixed, banned]) {
    await insertUserActorFollow(userId);
  }

  // One NPC follows the actor (control: no user tiers involved).
  const actorFollowId = await generateSnowflakeId();
  allActorFollowIds.push(actorFollowId);
  await db.insert(actorFollows).values({
    id: actorFollowId,
    followerId: npcFollowerId,
    followingId: actorId,
    createdAt: new Date(),
  });
});

afterAll(async () => {
  if (allUserActorFollowIds.length > 0) {
    await db
      .delete(userActorFollows)
      .where(inArray(userActorFollows.id, allUserActorFollowIds));
  }
  if (allActorFollowIds.length > 0) {
    await db
      .delete(actorFollows)
      .where(inArray(actorFollows.id, allActorFollowIds));
  }
  if (allUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, allUserIds));
  }
});

describe('actor stats follower counts count only visible members', () => {
  it('fixture sanity: five raw user follows and one NPC follow', async () => {
    const [userRows] = await db
      .select({ count: count() })
      .from(userActorFollows)
      .where(eq(userActorFollows.actorId, actorId));
    expect(Number(userRows?.count ?? 0)).toBe(5);
    const [actorRows] = await db
      .select({ count: count() })
      .from(actorFollows)
      .where(eq(actorFollows.followingId, actorId));
    expect(Number(actorRows?.count ?? 0)).toBe(1);
  });

  it('stats report the visible user-follower membership (2 of 5)', async () => {
    const request = new NextRequest(
      new Request(`http://localhost/api/actors/${actorId}/stats`)
    );
    const response = await GET_STATS(request, {
      params: Promise.resolve({ actorId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stats: {
        followers: number;
        following: number;
        posts: number;
        actorFollowers: number;
        userFollowers: number;
      };
    };
    // Only the two real user followers are visible members.
    expect(body.stats.userFollowers).toBe(2);
    // The NPC follower component is untouched by user tiers.
    expect(body.stats.actorFollowers).toBe(1);
    // The header total is the sum of the two visible components.
    expect(body.stats.followers).toBe(3);
  });
});

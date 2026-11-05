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

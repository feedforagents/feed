/**
 * Integration test — Profile "following" count vs the following list
 *
 * @route GET /api/users/by-username/[username]
 *
 * Real-database test: a user can follow both people (Follow rows) and NPC
 * actors (UserActorFollow rows, written by POST /api/users/[userId]/follow).
 * The following list (GET /api/users/[userId]/following) merges both sources
 * and its `count` is the total across all pages; the by-id profile stats
 * (CachedDatabaseService.getUserProfileStats) also add both sources
 * (`following + actorFollows`). The by-username profile stats must agree:
 * they are the same quantity shown on the same profile header.
 *
 * Pattern: stub only the `server-only` marker package; DB and the route
 * handlers all run for real against PostgreSQL. Fixture rows are namespaced
 * by a per-run id and are not deleted (same convention as the neighboring
 * profile count integration tests).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, follows, userActorFollows, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getFollowingList } from '../../[userId]/following/route';
import { GET as getProfile } from '../../[userId]/profile/route';
import { GET as getByUsername } from '../[username]/route';

const HUMAN_FOLLOWING = 3;
const ACTOR_FOLLOWING = 2;
const EXPECTED_FOLLOWING = HUMAN_FOLLOWING + ACTOR_FOLLOWING;

let targetId: string;
let targetUsername: string;

beforeAll(async () => {
  const runId = await generateSnowflakeId();
  targetId = await generateSnowflakeId();
  targetUsername = `f20-${runId.slice(-12)}`;
  const now = new Date();

  await db.insert(users).values({
    id: targetId,
    username: targetUsername,
    displayName: 'Following Count Fixture',
    updatedAt: now,
  });

  // People the target follows: plain Follow rows.
  const humanIds: string[] = [];
  for (let i = 0; i < HUMAN_FOLLOWING; i++) {
    humanIds.push(await generateSnowflakeId());
  }
  await db.insert(users).values(
    humanIds.map((id, i) => ({
      id,
      username: `f20-${runId.slice(-12)}-h${i}`,
      displayName: 'Followed human fixture',
      updatedAt: now,
    }))
  );
  await db.insert(follows).values(
    humanIds.map((id) => ({
      id: `fol-${runId}-${id}`,
      followerId: targetId,
      followingId: id,
      createdAt: now,
    }))
  );

  // Actors the target follows: UserActorFollow rows, as the follow route
  // writes them when a user follows an NPC actor.
  const actors = StaticDataRegistry.getAllActors();
  if (actors.length < ACTOR_FOLLOWING) {
    throw new Error('Static registry does not have enough actors');
  }
  await db.insert(userActorFollows).values(
    actors.slice(0, ACTOR_FOLLOWING).map((actor, i) => ({
      id: `uaf-${runId}-${i}`,
      userId: targetId,
      actorId: actor.id,
      createdAt: now,
    }))
  );

  // Decoy: one human follows the target. That is a follower relation and
  // must never enter the target's following count.
  const decoyId = await generateSnowflakeId();
  await db.insert(users).values({
    id: decoyId,
    username: `f20-${runId.slice(-12)}-decoy`,
    displayName: 'Decoy follower fixture',
    updatedAt: now,
  });
  await db.insert(follows).values({
    id: `fol-${runId}-decoy`,
    followerId: decoyId,
    followingId: targetId,
    createdAt: now,
  });
});

describe('profile following count vs following list', () => {
  it('following list counts people and actors the user follows', async () => {
    const response = await getFollowingList(
      new NextRequest(
        `https://feed.example/api/users/${targetId}/following?limit=50`
      ),
      { params: Promise.resolve({ userId: targetId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { count: number };
      count?: number;
    };
    const count = body.data?.count ?? body.count;
    expect(count).toBe(EXPECTED_FOLLOWING);
  });

  it('by-id profile stats count people and actor follows', async () => {
    const response = await getProfile(
      new NextRequest(`https://feed.example/api/users/${targetId}/profile`),
      { params: Promise.resolve({ userId: targetId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user?: { stats?: { following: number } } };
      user?: { stats?: { following: number } };
    };
    const user = body.data?.user ?? body.user;
    expect(user?.stats?.following).toBe(EXPECTED_FOLLOWING);
  });

  it('by-username profile stats agree with the following list', async () => {
    const response = await getByUsername(
      new NextRequest(
        `https://feed.example/api/users/by-username/${targetUsername}`
      ),
      { params: Promise.resolve({ username: targetUsername }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user?: { stats?: { following: number } } };
      user?: { stats?: { following: number } };
    };
    const user = body.data?.user ?? body.user;
    expect(user?.stats?.following).toBe(EXPECTED_FOLLOWING);
  });
});

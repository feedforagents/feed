/**
 * Profile follower counts against a real database: when NPCs follow a user
 * (FollowStatus rows written by the engine's following mechanics), the
 * follower count shown on the profile must include them, because the
 * followers list for the same user already does.
 *
 * The followers list is the ground truth here: its `count` is documented as
 * the total number of relations across all pages and it merges human follows
 * with active NPC follow statuses. The profile stats counters
 * (GET /api/users/[userId]/profile and GET /api/users/by-username/[username])
 * must agree with that total for the same user.
 *
 * Nothing is mocked: all three routes run against the real database.
 * Fixture rows are namespaced by a per-run id and are not deleted.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { db, followStatuses, follows, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getByUsername } from '../../../by-username/[username]/route';
import { GET as getFollowers } from '../../followers/route';
import { GET as getProfile } from '../route';

const HUMAN_FOLLOWERS = 2;
const NPC_FOLLOWERS = 2;
const EXPECTED_FOLLOWERS = HUMAN_FOLLOWERS + NPC_FOLLOWERS;

let targetId: string;
let targetUsername: string;
const npcIds: string[] = [];

beforeAll(async () => {
  const runId = await generateSnowflakeId();
  targetId = await generateSnowflakeId();
  targetUsername = `tpc-${runId.slice(-12)}`;
  const now = new Date();

  await db.insert(users).values({
    id: targetId,
    username: targetUsername,
    displayName: 'Profile Count Fixture',
    updatedAt: now,
  });

  // Human followers: plain Follow rows.
  const humanIds: string[] = [];
  for (let i = 0; i < HUMAN_FOLLOWERS; i++) {
    humanIds.push(await generateSnowflakeId());
  }
  await db.insert(users).values(
    humanIds.map((id, i) => ({
      id,
      username: `tpc-${runId.slice(-12)}-h${i}`,
      displayName: 'Human follower fixture',
      updatedAt: now,
    }))
  );
  await db.insert(follows).values(
    humanIds.map((id) => ({
      id: `fol-${runId}-${id}`,
      followerId: id,
      followingId: targetId,
      createdAt: now,
    }))
  );

  // NPC followers: active FollowStatus rows, as FollowingMechanics
  // .recordFollow writes them (reason is free text, never 'user_followed').
  const actors = StaticDataRegistry.getAllActors();
  if (actors.length < NPC_FOLLOWERS + 2) {
    throw new Error('Static registry does not have enough actors');
  }
  for (let i = 0; i < NPC_FOLLOWERS; i++) {
    npcIds.push(actors[i]!.id);
  }
  await db.insert(followStatuses).values(
    npcIds.map((npcId, i) => ({
      id: `fs-${runId}-${i}`,
      userId: targetId,
      npcId,
      isActive: true,
      followReason: 'quality reply streak',
      followedAt: new Date(now.getTime() - i * 1000),
    }))
  );

  // Rows the followers list excludes: an inactive NPC follow and a
  // 'user_followed' status. Neither may be counted anywhere.
  await db.insert(followStatuses).values([
    {
      id: `fs-${runId}-inactive`,
      userId: targetId,
      npcId: actors[NPC_FOLLOWERS]!.id,
      isActive: false,
      followReason: 'quality reply streak',
      followedAt: now,
    },
    {
      id: `fs-${runId}-userfollowed`,
      userId: targetId,
      npcId: actors[NPC_FOLLOWERS + 1]!.id,
      isActive: true,
      followReason: 'user_followed',
      followedAt: now,
    },
  ]);
});

describe('profile follower count vs followers list', () => {
  it('followers list counts human and NPC followers', async () => {
    const response = await getFollowers(
      new NextRequest(
        `https://feed.example/api/users/${targetId}/followers?limit=50`
      ),
      { params: Promise.resolve({ userId: targetId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { followers: Array<{ id: string }>; count: number };
      followers?: Array<{ id: string }>;
      count?: number;
    };
    const payload = body.data ?? body;
    expect(payload.count).toBe(EXPECTED_FOLLOWERS);
    const ids = (payload.followers ?? []).map((f) => f.id);
    for (const npcId of npcIds) {
      expect(ids).toContain(npcId);
    }
  });

  it('profile by id reports the same follower count', async () => {
    const response = await getProfile(
      new NextRequest(`https://feed.example/api/users/${targetId}/profile`),
      { params: Promise.resolve({ userId: targetId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user: { stats: { followers: number } } | null };
      user?: { stats: { followers: number } } | null;
    };
    const user = body.data?.user ?? body.user;
    expect(user?.stats.followers).toBe(EXPECTED_FOLLOWERS);
  });

  it('profile by username reports the same follower count', async () => {
    const response = await getByUsername(
      new NextRequest(
        `https://feed.example/api/users/by-username/${targetUsername}`
      ),
      { params: Promise.resolve({ username: targetUsername }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { user: { stats: { followers: number } } };
      user?: { stats: { followers: number } };
    };
    const user = body.data?.user ?? body.user;
    expect(user?.stats.followers).toBe(EXPECTED_FOLLOWERS);
  });
});

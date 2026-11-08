/**
 * NPC following list against a real database: every NPC has a row in the
 * users table (game bootstrap creates one with `isActor: true`, the actor's
 * own id as both id and username). The following list route documents that
 * it "supports both regular users and NPCs/actors" and has an actor branch
 * that returns the NPC's ActorFollow relations. The actor stats route
 * (GET /api/actors/[actorId]/stats) counts those same ActorFollow rows as
 * the NPC's following total.
 *
 * So for an NPC that follows other NPCs, the stats total and the following
 * list must agree: the list must contain the followed actors and report the
 * same count. A human user's following list (plain users + actor follows)
 * is the control case and must keep working.
 *
 * Nothing is mocked: the routes run against the real database. Fixture rows
 * are owned and removed after the run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  actorFollows,
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
import { GET as getActorStats } from '../../../apps/web/src/app/api/actors/[actorId]/stats/route';
import { GET as getFollowing } from '../../../apps/web/src/app/api/users/[userId]/following/route';

let npcId: string;
let npcName: string;
const followedActorIds: string[] = [];

let humanId: string;
let humanFolloweeId: string;
let humanFollowedActorId: string;

async function callFollowing(userId: string) {
  const response = await getFollowing(
    new NextRequest(
      `https://feed.example/api/users/${userId}/following?page=1&limit=100`
    ),
    { params: Promise.resolve({ userId }) }
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data?: {
      following: Array<{ id: string; displayName: string }>;
      count: number;
    };
    following?: Array<{ id: string; displayName: string }>;
    count?: number;
  };
  return (
    body.data ??
    (body as {
      following: Array<{ id: string; displayName: string }>;
      count: number;
    })
  );
}

beforeAll(async () => {
  const runId = await generateSnowflakeId();
  const now = new Date();

  // Real registry actors (skip test actors, whose ids start with 'test-').
  const actors = StaticDataRegistry.getAllActors().filter(
    (a) => !a.id.startsWith('test-')
  );
  if (actors.length < 3) {
    throw new Error('Static registry does not have enough actors');
  }
  const npc = actors[0]!;
  npcId = npc.id;
  npcName = npc.name;
  followedActorIds.push(actors[1]!.id, actors[2]!.id);

  // The NPC's users-table row, exactly as game bootstrap creates it
  // (packages/engine/src/services/game-bootstrap-service.ts): the actor id
  // doubles as id and username, isActor is true.
  await db.insert(users).values({
    id: npcId,
    username: npcId,
    displayName: npcName,
    isActor: true,
    virtualBalance: '10000',
    totalDeposited: '10000',
    totalWithdrawn: '0',
    lifetimePnL: '0',
    updatedAt: now,
  });

  // NPC -> NPC follows live in ActorFollow (engine writes them there).
  await db.insert(actorFollows).values(
    followedActorIds.map((followingId, i) => ({
      id: `af-${runId}-${i}`,
      followerId: npcId,
      followingId,
      createdAt: new Date(now.getTime() - i * 1000),
    }))
  );

  // Control: a human user following one human and one actor.
  humanId = await generateSnowflakeId();
  humanFolloweeId = await generateSnowflakeId();
  humanFollowedActorId = followedActorIds[0]!;
  await db.insert(users).values([
    {
      id: humanId,
      username: `tfl-${runId.slice(-12)}-h`,
      displayName: 'Human fixture',
      updatedAt: now,
    },
    {
      id: humanFolloweeId,
      username: `tfl-${runId.slice(-12)}-u`,
      displayName: 'Human followee fixture',
      updatedAt: now,
    },
  ]);
  await db.insert(follows).values({
    id: `fol-${runId}-h`,
    followerId: humanId,
    followingId: humanFolloweeId,
    createdAt: now,
  });
  await db.insert(userActorFollows).values({
    id: `uaf-${runId}-h`,
    userId: humanId,
    actorId: humanFollowedActorId,
    createdAt: now,
  });
});

afterAll(async () => {
  await db.delete(actorFollows).where(eq(actorFollows.followerId, npcId));
  await db.delete(userActorFollows).where(eq(userActorFollows.userId, humanId));
  await db.delete(follows).where(eq(follows.followerId, humanId));
  await db
    .delete(users)
    .where(inArray(users.id, [npcId, humanId, humanFolloweeId]));
});

describe('following list for an NPC target', () => {
  it('actor stats count the NPC follows (ground truth)', async () => {
    const response = await getActorStats(
      new NextRequest(`https://feed.example/api/actors/${npcId}/stats`),
      { params: Promise.resolve({ actorId: npcId }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data?: { stats: { following: number } };
      stats?: { following: number };
    };
    const stats = body.data?.stats ?? body.stats;
    expect(stats?.following).toBe(followedActorIds.length);
  });

  it('following list returns the actors the NPC follows', async () => {
    const payload = await callFollowing(npcId);
    expect(payload.count).toBe(followedActorIds.length);
    const ids = payload.following.map((f) => f.id);
    for (const actorId of followedActorIds) {
      expect(ids).toContain(actorId);
    }
  });
});

describe('following list for a human target (control)', () => {
  it('returns the followed user and actor', async () => {
    const payload = await callFollowing(humanId);
    expect(payload.count).toBe(2);
    const ids = payload.following.map((f) => f.id);
    expect(ids).toContain(humanFolloweeId);
    expect(ids).toContain(humanFollowedActorId);
  });
});

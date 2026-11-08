/**
 * Profile header counts after a block, against a real database.
 *
 * Blocking removes the follow relationships in both directions (the block
 * route deletes both `follows` rows in its transaction), so from that
 * moment neither user's profile may count the other. The followers list
 * route reads the rows directly and drops both names at once; the profile
 * header stats come from `GET /api/users/[userId]/profile`, which serves
 * the cached profile stats. The follow/unfollow route — the other path
 * that changes these counts — invalidates both users' caches when it
 * changes the same rows. The block route must do the same, or the header
 * keeps counting a follow relationship the block just removed (and the
 * same screen's followers list already shows gone) until the cache TTL
 * expires.
 *
 * Auth uses the existing CI synthetic bearer (`steward:test:<userId>`).
 * The only stub is the `server-only` marker package; the block route,
 * the profile route, the followers list route, the cache layer and the
 * database all run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { and, db, eq, follows, inArray, or, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ProfileStats = {
  followers: number;
  following: number;
  posts: number;
  comments: number;
  reactions: number;
  positions: number;
};

type ProfileBody = {
  user?: { id: string; stats: ProfileStats | null } | null;
  data?: { user?: { id: string; stats: ProfileStats | null } | null };
};

let blockerId: string;
let targetId: string;
const ownedUsers: string[] = [];

let blockPOST: typeof import('../../../apps/web/src/app/api/users/[userId]/block/route').POST;
let profileGET: typeof import('../../../apps/web/src/app/api/users/[userId]/profile/route').GET;
let followersGET: typeof import('../../../apps/web/src/app/api/users/[userId]/followers/route').GET;

async function readProfileStats(userId: string): Promise<ProfileStats> {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/profile`)
  );
  const response = await profileGET(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as ProfileBody;
  const user = body.user ?? body.data?.user;
  expect(user?.id).toBe(userId);
  const stats = user?.stats;
  expect(stats).not.toBeNull();
  return stats as ProfileStats;
}

async function readFollowersCount(userId: string): Promise<number> {
  const request = new NextRequest(
    new Request(`http://localhost/api/users/${userId}/followers`)
  );
  const response = await followersGET(request, {
    params: Promise.resolve({ userId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    count?: number;
    data?: { count?: number };
  };
  return (body.count ?? body.data?.count) as number;
}

async function followRow(followerId: string, followingId: string) {
  const rows = await db
    .select({ id: follows.id })
    .from(follows)
    .where(
      and(
        eq(follows.followerId, followerId),
        eq(follows.followingId, followingId)
      )
    );
  return rows[0] ?? null;
}

beforeAll(async () => {
  ({ POST: blockPOST } = await import(
    '../../../apps/web/src/app/api/users/[userId]/block/route'
  ));
  ({ GET: profileGET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/profile/route'
  ));
  ({ GET: followersGET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/followers/route'
  ));

  [blockerId, targetId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  ownedUsers.push(blockerId, targetId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: blockerId,
      username: `f76a-${blockerId}`,
      displayName: 'Block Stats Blocker',
      updatedAt: now,
    },
    {
      id: targetId,
      username: `f76b-${targetId}`,
      displayName: 'Block Stats Target',
      updatedAt: now,
    },
  ]);

  // Mutual follows, seeded directly: the follow route is not under test
  // here (it already invalidates), the block route's cache behaviour is.
  await db.insert(follows).values([
    {
      id: await generateSnowflakeId(),
      followerId: blockerId,
      followingId: targetId,
    },
    {
      id: await generateSnowflakeId(),
      followerId: targetId,
      followingId: blockerId,
    },
  ]);
});

afterAll(async () => {
  if (ownedUsers.length === 0) return;
  await db
    .delete(follows)
    .where(
      or(
        inArray(follows.followerId, ownedUsers),
        inArray(follows.followingId, ownedUsers)
      )
    );
  await db
    .delete(userBlocks)
    .where(
      or(
        inArray(userBlocks.blockerId, ownedUsers),
        inArray(userBlocks.blockedId, ownedUsers)
      )
    );
  await db.delete(users).where(inArray(users.id, ownedUsers));
});

describe('profile header counts after a block', () => {
  it('stops counting the removed follows on both profiles immediately', async () => {
    // Prime both profiles' cached stats while the mutual follows exist.
    const targetBefore = await readProfileStats(targetId);
    expect(targetBefore.followers).toBe(1);
    expect(targetBefore.following).toBe(1);
    const blockerBefore = await readProfileStats(blockerId);
    expect(blockerBefore.followers).toBe(1);
    expect(blockerBefore.following).toBe(1);
    expect(await readFollowersCount(targetId)).toBe(1);

    // Block through the real route.
    const request = new NextRequest(
      new Request(`http://localhost/api/users/${targetId}/block`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer steward:test:${blockerId}`,
        },
        body: JSON.stringify({ action: 'block' }),
      })
    );
    const response = await blockPOST(request, {
      params: Promise.resolve({ userId: targetId }),
    });
    expect(response.status).toBe(200);

    // The block really removed both follow rows, and the (uncached)
    // followers list already agrees.
    expect(await followRow(blockerId, targetId)).toBeNull();
    expect(await followRow(targetId, blockerId)).toBeNull();
    expect(await readFollowersCount(targetId)).toBe(0);

    // The header stats on both profiles must stop counting the removed
    // follows at once — not when the stats cache happens to expire.
    const targetAfter = await readProfileStats(targetId);
    expect(targetAfter.followers).toBe(0);
    expect(targetAfter.following).toBe(0);
    const blockerAfter = await readProfileStats(blockerId);
    expect(blockerAfter.followers).toBe(0);
    expect(blockerAfter.following).toBe(0);
  });
});

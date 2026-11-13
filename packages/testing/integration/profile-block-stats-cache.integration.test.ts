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

import { and, db, eq, follows, inArray, userBlocks, users } from '@feed/db';
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

type UserInsert = typeof users.$inferInsert;
type FollowInsert = typeof follows.$inferInsert;

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID, so a setup that fails partway (for example on
 * an ID collision with a pre-existing row) can never delete data this
 * fixture did not create.
 */
class OwnedFixtures {
  readonly userIds: string[] = [];
  readonly followIds: string[] = [];
  readonly blockIds: string[] = [];

  async insertUser(values: UserInsert): Promise<string> {
    const [row] = await db
      .insert(users)
      .values(values)
      .returning({ id: users.id });
    if (!row) throw new Error('user insert returned no row');
    this.userIds.push(row.id);
    return row.id;
  }

  async insertFollow(values: FollowInsert): Promise<string> {
    const [row] = await db
      .insert(follows)
      .values(values)
      .returning({ id: follows.id });
    if (!row) throw new Error('follow insert returned no row');
    this.followIds.push(row.id);
    return row.id;
  }

  /**
   * The block row is created by the API under test, not by an INSERT
   * here. Recover its ID only under the successfully acquired
   * caller/target pair, so cleanup removes exactly that row.
   */
  async trackBlock(blockerId: string, blockedId: string): Promise<void> {
    const [row] = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, blockerId),
          eq(userBlocks.blockedId, blockedId)
        )
      );
    if (row) this.blockIds.push(row.id);
  }

  async cleanup(): Promise<void> {
    if (this.followIds.length > 0) {
      await db.delete(follows).where(inArray(follows.id, this.followIds));
    }
    if (this.blockIds.length > 0) {
      await db.delete(userBlocks).where(inArray(userBlocks.id, this.blockIds));
    }
    if (this.userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, this.userIds));
    }
    this.userIds.length = 0;
    this.followIds.length = 0;
    this.blockIds.length = 0;
  }
}

const fixtures = new OwnedFixtures();
let blockerId: string;
let targetId: string;

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

  const now = new Date();
  const newBlockerId = await generateSnowflakeId();
  blockerId = await fixtures.insertUser({
    id: newBlockerId,
    username: `f76a-${newBlockerId}`,
    displayName: 'Block Stats Blocker',
    updatedAt: now,
  });
  const newTargetId = await generateSnowflakeId();
  targetId = await fixtures.insertUser({
    id: newTargetId,
    username: `f76b-${newTargetId}`,
    displayName: 'Block Stats Target',
    updatedAt: now,
  });

  // Mutual follows, seeded directly: the follow route is not under test
  // here (it already invalidates), the block route's cache behaviour is.
  await fixtures.insertFollow({
    id: await generateSnowflakeId(),
    followerId: blockerId,
    followingId: targetId,
  });
  await fixtures.insertFollow({
    id: await generateSnowflakeId(),
    followerId: targetId,
    followingId: blockerId,
  });
});

afterAll(async () => {
  await fixtures.cleanup();
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

    // Register the API-created block row under the owned pair so
    // teardown removes exactly that row.
    await fixtures.trackBlock(blockerId, targetId);

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

describe('fixture ownership', () => {
  it('cleanup after failed setup never deletes rows the fixture did not create', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const now = new Date();
      const victimBlockerRaw = await generateSnowflakeId();
      const victimBlockerId = await victim.insertUser({
        id: victimBlockerRaw,
        username: `f76v1-${victimBlockerRaw}`,
        displayName: 'Pre-existing blocker',
        updatedAt: now,
      });
      const victimTargetRaw = await generateSnowflakeId();
      const victimTargetId = await victim.insertUser({
        id: victimTargetRaw,
        username: `f76v2-${victimTargetRaw}`,
        displayName: 'Pre-existing target',
        updatedAt: now,
      });
      const victimFollowId = await victim.insertFollow({
        id: await generateSnowflakeId(),
        followerId: victimBlockerId,
        followingId: victimTargetId,
      });

      // A user INSERT that collides with the pre-existing user fails and
      // registers no ownership.
      let userCollisionFailed = false;
      try {
        await attempt.insertUser({
          id: victimBlockerId,
          username: `f76c-${victimBlockerId}`,
          displayName: 'Collision attempt',
          updatedAt: now,
        });
      } catch {
        userCollisionFailed = true;
      }
      expect(userCollisionFailed).toBe(true);
      expect(attempt.userIds).toEqual([]);

      // Partial setup: the user insert succeeds, then the follow INSERT
      // collides with the pre-existing follow and registers nothing.
      const attemptUserRaw = await generateSnowflakeId();
      const attemptUserId = await attempt.insertUser({
        id: attemptUserRaw,
        username: `f76p-${attemptUserRaw}`,
        displayName: 'Partial setup',
        updatedAt: now,
      });
      let followCollisionFailed = false;
      try {
        await attempt.insertFollow({
          id: victimFollowId,
          followerId: attemptUserId,
          followingId: victimTargetId,
        });
      } catch {
        followCollisionFailed = true;
      }
      expect(followCollisionFailed).toBe(true);
      expect(attempt.followIds).toEqual([]);

      await attempt.cleanup();

      // The pre-existing rows survive the failed setup's cleanup
      // untouched, and the one acquired row is removed.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, victimBlockerId));
      expect(survivingUser?.displayName).toBe('Pre-existing blocker');
      expect(await followRow(victimBlockerId, victimTargetId)).not.toBeNull();
      const [removedUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, attemptUserId));
      expect(removedUser).toBeUndefined();
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});

import { afterAll, describe, expect, it } from 'bun:test';
import {
  and,
  db,
  dbWrite,
  eq,
  follows,
  inArray,
  notifications,
  or,
  sql,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';

/**
 * The supported isolated integration-test DID: with
 * ALLOW_TEST_PRIVY_DID_AUTH the server authenticates
 * `Bearer steward:test:<userId>` directly as that user, with no JWT and
 * no Steward round-trip.
 */
function testAuthHeader(userId: string) {
  return `Bearer steward:test:${userId}`;
}

const ownedUsers: string[] = [];

async function fixtureUser(): Promise<string> {
  const userId = await generateSnowflakeId();
  ownedUsers.push(userId);
  await db.insert(users).values({
    id: userId,
    stewardId: `follow-block-${userId}`,
    privyId: `did:privy:test-${userId}`,
    username: `follow-block-${userId}`,
    updatedAt: new Date(),
  });
  return userId;
}

async function postFollow(followerId: string, targetId: string) {
  return fetch(`${baseUrl}/api/users/${targetId}/follow`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: testAuthHeader(followerId),
    },
  });
}

async function postBlock(blockerId: string, targetId: string) {
  return fetch(`${baseUrl}/api/users/${targetId}/block`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: testAuthHeader(blockerId),
    },
    body: JSON.stringify({ action: 'block' }),
  });
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

async function blockRow(blockerId: string, blockedId: string) {
  const rows = await db
    .select({ id: userBlocks.id })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, blockerId),
        eq(userBlocks.blockedId, blockedId)
      )
    );
  return rows[0] ?? null;
}

afterAll(async () => {
  if (ownedUsers.length === 0) return;
  await db
    .delete(notifications)
    .where(inArray(notifications.userId, ownedUsers));
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

describe('POST /api/users/[userId]/follow block enforcement', () => {
  it('rejects a follow from a user the target has blocked', async () => {
    const userAId = await fixtureUser();
    const userBId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userAId,
      blockedId: userBId,
    });

    const response = await postFollow(userBId, userAId);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Cannot follow this user');
    expect(await followRow(userBId, userAId)).toBeNull();
  });

  it('rejects a follow toward a user the follower has blocked', async () => {
    const userAId = await fixtureUser();
    const userBId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userAId,
      blockedId: userBId,
    });

    const response = await postFollow(userAId, userBId);
    expect(response.status).toBe(400);
    expect(await followRow(userAId, userBId)).toBeNull();
  });

  it('rejects a follow when the block is in the other pair direction', async () => {
    const userDId = await fixtureUser();
    const userEId = await fixtureUser();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: userDId,
      blockedId: userEId,
    });

    const response = await postFollow(userEId, userDId);
    expect(response.status).toBe(400);
    expect(await followRow(userEId, userDId)).toBeNull();
  });

  it('still allows a follow with no block relationship', async () => {
    const userAId = await fixtureUser();
    const userCId = await fixtureUser();

    const response = await postFollow(userCId, userAId);
    expect(response.status).toBe(201);
    expect(await followRow(userCId, userAId)).not.toBeNull();
  });

  it('a block committed while a follow is in flight leaves no follow behind', async () => {
    const userAId = await fixtureUser();
    const userBId = await fixtureUser();

    // Warm the block route first: its first-hit compile must not eat the
    // window between the follow pausing and the block running. The target
    // does not exist, so this only loads the route (404, no side effects).
    const warmup = await postBlock(userAId, '0000000000000000001');
    expect(warmup.status).toBe(404);

    // Pause the follow request at its INSERT with an uncommitted,
    // uniquely conflicting fixture edge: the INSERT waits on the
    // speculative-insertion lock while the block request runs.
    const barrierId = await generateSnowflakeId();
    const release = Promise.withResolvers<void>();
    const barrier = dbWrite.transaction(async (tx) => {
      await tx.insert(follows).values({
        id: barrierId,
        followerId: userBId,
        followingId: userAId,
      });
      await release.promise;
    });
    // The barrier rolls back when released; swallow that expected error.
    const barrierDone = barrier.catch(() => undefined);
    try {
      const followPromise = postFollow(userBId, userAId);

      // Wait until the follow request is actually paused at its INSERT
      // before starting the block, or the race is not exercised.
      const until = Date.now() + 15_000;
      let waiting = 0;
      while (Date.now() < until) {
        const rows = await dbWrite.execute(
          sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%Follow%'`
        );
        waiting = Number(rows[0]?.count ?? 0);
        if (waiting >= 1) break;
        await Bun.sleep(25);
      }
      expect(waiting).toBeGreaterThanOrEqual(1);

      const blockPromise = postBlock(userAId, userBId);

      // Wait until the block has either committed (its row is visible) or
      // is queued behind the follow's pair lock (it waits on the advisory
      // lock). Only then release the barrier, so the follow's INSERT is
      // guaranteed to land after the block committed — otherwise the
      // block could still be compiling while the follow slips through,
      // and the race would not be exercised at all.
      const untilBlock = Date.now() + 15_000;
      let blockSettled = false;
      while (Date.now() < untilBlock) {
        if (await blockRow(userAId, userBId)) {
          blockSettled = true;
          break;
        }
        const lockRows = await dbWrite.execute(
          sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock%'`
        );
        if (Number(lockRows[0]?.count ?? 0) >= 1) {
          blockSettled = true;
          break;
        }
        await Bun.sleep(25);
      }
      expect(blockSettled).toBe(true);

      release.reject(new Error('release barrier'));

      const [followResponse, blockResponse] = await Promise.all([
        followPromise,
        blockPromise,
      ]);
      expect(blockResponse.status).toBe(200);
      // The follow may legitimately win the race (201) — the block then
      // deletes it. What must never survive is a follow alongside a block.
      expect(followResponse.status).toBe(201);
      expect(await blockRow(userAId, userBId)).not.toBeNull();
      expect(await followRow(userBId, userAId)).toBeNull();
      expect(await followRow(userAId, userBId)).toBeNull();
    } finally {
      release.reject(new Error('release barrier'));
      await barrierDone;
    }
  }, 60_000);
});
